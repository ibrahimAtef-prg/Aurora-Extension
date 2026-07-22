"""
overfitting_detector.py — Structural Overfitting Detection
===========================================================

Detects when the generator has learned the SHAPE of the dataset
rather than its DISTRIBUTION. Three independent tests:

1. JS-divergence from baseline distributions (histogram similarity)
2. Correlation matrix difference (feature independence preservation)
3. Mode collapse (unique_ratio below threshold)

Any individual failure raises PipelineHardFail.
The aggregate overfitting_score is returned for audit logging.

Usage
-----
    from overfitting_detector import check_overfitting

    check_overfitting(synthetic_df, baseline, stage="post_generation")
    # raises PipelineHardFail if structural overfitting is detected

Integration point: enforcement_engine.run_post_stage()
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from pipeline_errors import PipelineHardFail


# ==================================================================
# Thresholds
# ==================================================================

_MAX_JS_DIVERGENCE     = 0.30   # > 30% divergence from baseline = overfit to noise
_MAX_CORR_DIFF         = 0.40   # > 40% avg correlation matrix diff = structure lost
_MIN_UNIQUE_RATIO      = 0.01   # < 1% unique rows = mode collapse
_MAX_OVERFITTING_SCORE = 0.60   # composite score threshold


# ==================================================================
# Public API
# ==================================================================

def check_overfitting(
    synthetic_df: pd.DataFrame,
    baseline:     Any,           # BaselineArtifact duck-typed
    original_df:  Optional[pd.DataFrame] = None,
    stage:        str = "overfitting_detector",
    n_bins:       int = 20,
) -> Dict[str, Any]:
    """
    Run all three overfitting checks. Raises PipelineHardFail on failure.

    Parameters
    ----------
    synthetic_df : generated DataFrame
    baseline     : BaselineArtifact (has .columns.numeric / .categorical)
    original_df  : original training DataFrame (for correlation diff)
                   if None, correlation check is skipped
    stage        : stage label for error context
    n_bins       : bins for histogram JS-divergence

    Returns
    -------
    dict with keys: overfitting_score, js_scores, corr_diff, unique_ratio
    """
    results: Dict[str, Any] = {
        "overfitting_score": 0.0,
        "js_scores":         {},
        "corr_diff":         None,
        "unique_ratio":      None,
        "checks_failed":     [],
    }

    fail_reasons: List[str] = []
    score_components: List[float] = []

    # ── 1. JS-divergence vs baseline distributions ────────────────
    bl_numeric = (getattr(baseline, "columns", {}) or {}).get("numeric", {}) or {}
    js_scores: Dict[str, float] = {}

    for col, spec in bl_numeric.items():
        if col not in synthetic_df.columns:
            continue
        try:
            synth_vals = pd.to_numeric(synthetic_df[col], errors="coerce").dropna().values
            if len(synth_vals) < 5:
                continue

            # Reconstruct reference distribution from baseline quantiles
            q = spec.get("quantiles") or spec.get("percentiles") or []
            if len(q) >= 5:
                ref_vals = np.array(q, dtype=float)
            elif spec.get("mean") is not None and spec.get("std") is not None:
                rng      = np.random.default_rng(42)
                ref_vals = rng.normal(spec["mean"], max(spec["std"], 1e-6), 500)
            else:
                continue

            js = _js_divergence(ref_vals, synth_vals, n_bins)
            js_scores[col] = round(js, 4)

            if js > _MAX_JS_DIVERGENCE:
                fail_reasons.append(
                    f"JS-divergence for '{col}' = {js:.4f} > {_MAX_JS_DIVERGENCE} "
                    f"(synthetic distribution deviates excessively from baseline)"
                )
        except Exception:
            continue

    if js_scores:
        avg_js = float(np.mean(list(js_scores.values())))
        score_components.append(avg_js / _MAX_JS_DIVERGENCE)
        results["js_scores"] = js_scores

    # ── 2. Correlation matrix diff ────────────────────────────────
    if original_df is not None:
        try:
            num_cols = [c for c in synthetic_df.columns
                        if pd.api.types.is_numeric_dtype(synthetic_df[c])
                        and c in original_df.columns]
            if len(num_cols) >= 2:
                corr_orig  = original_df[num_cols].corr().fillna(0).values
                corr_synth = synthetic_df[num_cols].corr().fillna(0).values
                diff       = float(np.abs(corr_orig - corr_synth).mean())
                results["corr_diff"] = round(diff, 4)
                score_components.append(diff / _MAX_CORR_DIFF)

                if diff > _MAX_CORR_DIFF:
                    fail_reasons.append(
                        f"Correlation matrix avg diff = {diff:.4f} > {_MAX_CORR_DIFF} "
                        "(feature independence structure has been destroyed or overfit)"
                    )
        except Exception:
            pass

    # ── 3. Mode collapse — unique row ratio ───────────────────────
    try:
        n_total  = len(synthetic_df)
        n_unique = len(synthetic_df.drop_duplicates())
        unique_ratio = n_unique / max(n_total, 1)
        results["unique_ratio"] = round(unique_ratio, 4)
        score_components.append(
            max(0.0, (_MIN_UNIQUE_RATIO - unique_ratio) / _MIN_UNIQUE_RATIO)
        )
        if unique_ratio < _MIN_UNIQUE_RATIO:
            fail_reasons.append(
                f"Unique row ratio = {unique_ratio:.4f} < {_MIN_UNIQUE_RATIO} "
                f"(mode collapse: generator is repeating near-identical rows)"
            )
    except Exception:
        pass

    # ── Composite score ───────────────────────────────────────────
    overfitting_score = (
        float(np.mean(score_components)) if score_components else 0.0
    )
    results["overfitting_score"] = round(overfitting_score, 4)
    results["checks_failed"]     = fail_reasons

    # ── Enforcement ───────────────────────────────────────────────
    if fail_reasons:
        raise PipelineHardFail(
            message = (
                f"STRUCTURAL OVERFITTING DETECTED (score={overfitting_score:.4f}): "
                + "; ".join(fail_reasons)
            ),
            stage   = stage,
            context = results,
        )

    if overfitting_score > _MAX_OVERFITTING_SCORE:
        raise PipelineHardFail(
            message = (
                f"OVERFITTING SCORE {overfitting_score:.4f} > {_MAX_OVERFITTING_SCORE}: "
                "composite overfitting indicator exceeds hard threshold — "
                "generator has learned dataset shape, not distribution"
            ),
            stage   = stage,
            context = results,
        )

    return results


# ==================================================================
# Helpers
# ==================================================================

def _js_divergence(
    ref:    np.ndarray,
    synth:  np.ndarray,
    n_bins: int = 20,
) -> float:
    lo    = float(min(ref.min(), synth.min()))
    hi    = float(max(ref.max(), synth.max()))
    if lo == hi:
        return 0.0
    edges  = np.linspace(lo, hi, n_bins + 1)
    p, _   = np.histogram(ref,   bins=edges, density=True)
    q, _   = np.histogram(synth, bins=edges, density=True)
    p      = p.astype(float) + 1e-10
    q      = q.astype(float) + 1e-10
    p     /= p.sum()
    q     /= q.sum()
    m      = 0.5 * (p + q)
    kl_pm  = float(np.sum(p[p > 0] * np.log(p[p > 0] / m[p > 0])))
    kl_qm  = float(np.sum(q[q > 0] * np.log(q[q > 0] / m[q > 0])))
    return min(1.0, max(0.0, 0.5 * kl_pm + 0.5 * kl_qm))
