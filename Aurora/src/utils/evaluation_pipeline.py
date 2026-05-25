"""
evaluation_pipeline.py — Independent Evaluation Pipeline
==========================================================

Separate from the generation pipeline. Recomputes metrics from scratch
using ONLY the final generated rows and the original dataset.

RULE: This module NEVER imports from generator.py or reads internal
      generator state. It operates only on the final output artifacts.

Purpose
-------
Prevents the known failure pattern where evaluation reuses internal
generator distributions (biased toward its own output), producing
optimistically inflated fidelity scores.

What it computes
----------------
1. Column-level JS-divergence (distribution fidelity)
2. Row-level uniqueness vs. originals (deduplication quality)
3. Numeric range adherence (no OOB values)
4. Categorical set adherence (no invented values)
5. Summary verdict: PASS | WARN | FAIL

All results are returned as a structured dict that is appended to
the generator output under the key "evaluation".

Usage
-----
    from evaluation_pipeline import evaluate

    result = evaluate(
        synthetic_rows  = generator_output["samples"],
        original_path   = "/data/train.csv",
        baseline        = baseline_artifact_dict,
    )
    # result["verdict"] in ("PASS", "WARN", "FAIL")
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd


# ==================================================================
# Public entry point
# ==================================================================

def evaluate(
    synthetic_rows:  List[Dict[str, Any]],
    original_path:   str,
    baseline:        Dict[str, Any],
    n_bins:          int = 20,
) -> Dict[str, Any]:
    """
    Run independent evaluation of generated synthetic rows.

    Parameters
    ----------
    synthetic_rows : list of row dicts from generator output["samples"]
    original_path  : absolute path to the original dataset file
    baseline       : BaselineArtifact dict (from baseline.py output)
    n_bins         : number of bins for histogram comparison

    Returns
    -------
    dict with keys:
        verdict         : "PASS" | "WARN" | "FAIL"
        column_fidelity : {col: {"js_divergence": float, "pass": bool}}
        range_adherence : {col: {"n_oob": int, "pass": bool}}
        cat_adherence   : {col: {"n_invented": int, "pass": bool}}
        duplicate_rate  : float   (fraction of exact matches with original)
        warnings        : list[str]
        errors          : list[str]
    """
    warnings_out: List[str] = []
    errors_out:   List[str] = []

    # ── Load synthetic DataFrame ──────────────────────────────────
    if not synthetic_rows:
        return _fail_result("No synthetic rows to evaluate", errors_out, warnings_out)

    try:
        synth_df = pd.DataFrame(synthetic_rows)
    except Exception as e:
        return _fail_result(f"Cannot build synthetic DataFrame: {e}", errors_out, warnings_out)

    # ── Load original DataFrame ───────────────────────────────────
    try:
        orig_df = _load_original(original_path)
    except Exception as e:
        warnings_out.append(f"Cannot load original dataset (skipping fidelity checks): {e}")
        orig_df = None

    bl_num = baseline.get("columns", {}).get("numeric",      {}) or {}
    bl_cat = baseline.get("columns", {}).get("categorical",  {}) or {}

    # ── 1. Column-level JS-divergence ────────────────────────────
    col_fidelity: Dict[str, Any] = {}
    if orig_df is not None:
        for col, spec in bl_num.items():
            if col not in synth_df.columns or col not in orig_df.columns:
                continue
            js = _js_divergence_numeric(
                orig_df[col].dropna().values.astype(float),
                synth_df[col].dropna().values.astype(float),
                n_bins = n_bins,
            )
            col_fidelity[col] = {
                "js_divergence": round(js, 4),
                "type":          "numeric",
                "pass":          js < 0.25,  # > 0.25 JS = notable drift
            }
        for col, spec in bl_cat.items():
            if col not in synth_df.columns or col not in orig_df.columns:
                continue
            js = _js_divergence_categorical(
                orig_df[col].dropna().astype(str).values,
                synth_df[col].dropna().astype(str).values,
            )
            col_fidelity[col] = {
                "js_divergence": round(js, 4),
                "type":          "categorical",
                "pass":          js < 0.20,
            }

    # ── 2. Numeric range adherence ────────────────────────────────
    range_adherence: Dict[str, Any] = {}
    for col, spec in bl_num.items():
        if col not in synth_df.columns:
            continue
        lo = spec.get("min")
        hi = spec.get("max")
        if lo is None or hi is None:
            continue
        s        = pd.to_numeric(synth_df[col], errors="coerce").dropna()
        n_oob    = int(((s < lo) | (s > hi)).sum())
        oob_rate = n_oob / max(len(s), 1)
        range_adherence[col] = {
            "n_oob":    n_oob,
            "oob_rate": round(oob_rate, 4),
            "pass":     oob_rate < 0.01,   # < 1% OOB allowed
        }
        if oob_rate >= 0.01:
            warnings_out.append(
                f"Range adherence: column '{col}' has {n_oob} OOB values "
                f"({oob_rate:.1%}) outside [{lo}, {hi}]"
            )

    # ── 3. Categorical set adherence ─────────────────────────────
    cat_adherence: Dict[str, Any] = {}
    for col, spec in bl_cat.items():
        if col not in synth_df.columns:
            continue
        allowed = set(str(v) for v in (spec.get("allowed_values") or []))
        if not allowed:
            continue
        synth_vals = synth_df[col].dropna().astype(str)
        invented   = synth_vals[~synth_vals.isin(allowed)]
        n_inv      = len(invented)
        inv_rate   = n_inv / max(len(synth_vals), 1)
        cat_adherence[col] = {
            "n_invented": n_inv,
            "inv_rate":   round(inv_rate, 4),
            "pass":       n_inv == 0,
            "examples":   invented.unique()[:5].tolist() if n_inv > 0 else [],
        }
        if n_inv > 0:
            errors_out.append(
                f"Categorical adherence: column '{col}' has {n_inv} invented "
                f"values not in original set. Examples: {invented.unique()[:3].tolist()}"
            )

    # ── 4. Duplicate rate vs. original ───────────────────────────
    dup_rate = 0.0
    if orig_df is not None:
        try:
            common_cols = [c for c in synth_df.columns if c in orig_df.columns]
            if common_cols:
                orig_strs  = set(
                    orig_df[common_cols].fillna("").astype(str).apply(
                        lambda r: "|".join(r.values), axis=1
                    )
                )
                synth_strs = synth_df[common_cols].fillna("").astype(str).apply(
                    lambda r: "|".join(r.values), axis=1
                )
                n_dup    = int(synth_strs.isin(orig_strs).sum())
                dup_rate = round(n_dup / max(len(synth_df), 1), 4)
                if dup_rate > 0.10:
                    warnings_out.append(
                        f"Duplicate rate: {n_dup} synthetic rows ({dup_rate:.1%}) "
                        "exactly match original rows — possible memorisation"
                    )
        except Exception as e:
            warnings_out.append(f"Duplicate check failed: {e}")

    # ── 5. Verdict ────────────────────────────────────────────────
    has_errors   = len(errors_out) > 0
    fidelity_failures = [c for c, v in col_fidelity.items() if not v.get("pass", True)]
    range_fails  = [c for c, v in range_adherence.items() if not v.get("pass", True)]

    if has_errors or dup_rate > 0.40:
        verdict = "FAIL"
    elif fidelity_failures or range_fails or len(warnings_out) > 3:
        verdict = "WARN"
    else:
        verdict = "PASS"

    return {
        "verdict":          verdict,
        "column_fidelity":  col_fidelity,
        "range_adherence":  range_adherence,
        "cat_adherence":    cat_adherence,
        "duplicate_rate":   dup_rate,
        "warnings":         warnings_out,
        "errors":           errors_out,
        "n_synthetic_rows": len(synth_df),
        "n_original_rows":  len(orig_df) if orig_df is not None else None,
    }


# ==================================================================
# Private helpers
# ==================================================================

def _js_divergence_numeric(
    orig:   np.ndarray,
    synth:  np.ndarray,
    n_bins: int = 20,
) -> float:
    """Jensen-Shannon divergence between two numeric arrays."""
    if len(orig) == 0 or len(synth) == 0:
        return 0.0
    lo  = float(min(orig.min(), synth.min()))
    hi  = float(max(orig.max(), synth.max()))
    if lo == hi:
        return 0.0
    edges     = np.linspace(lo, hi, n_bins + 1)
    p, _      = np.histogram(orig,  bins=edges, density=True)
    q, _      = np.histogram(synth, bins=edges, density=True)
    p         = p.astype(float) + 1e-10
    q         = q.astype(float) + 1e-10
    p        /= p.sum()
    q        /= q.sum()
    m         = 0.5 * (p + q)
    js        = 0.5 * _kl(p, m) + 0.5 * _kl(q, m)
    return float(min(1.0, max(0.0, js)))


def _js_divergence_categorical(
    orig:  np.ndarray,
    synth: np.ndarray,
) -> float:
    """JS-divergence between two categorical series."""
    if len(orig) == 0 or len(synth) == 0:
        return 0.0
    cats = sorted(set(orig) | set(synth))
    o_counts = np.array([float((orig  == c).sum()) for c in cats]) + 1e-10
    s_counts = np.array([float((synth == c).sum()) for c in cats]) + 1e-10
    p = o_counts / o_counts.sum()
    q = s_counts / s_counts.sum()
    m = 0.5 * (p + q)
    return float(min(1.0, max(0.0, 0.5 * _kl(p, m) + 0.5 * _kl(q, m))))


def _kl(p: np.ndarray, q: np.ndarray) -> float:
    """KL divergence D(P||Q)."""
    mask = p > 0
    return float(np.sum(p[mask] * np.log(p[mask] / q[mask])))


def _load_original(path: str) -> pd.DataFrame:
    import os
    ext = os.path.splitext(path)[1].lower()
    if ext in (".csv", ".tsv"):
        return pd.read_csv(path)
    if ext in (".xlsx", ".xlsm"):
        return pd.read_excel(path)
    if ext == ".json":
        try:
            return pd.read_json(path)
        except Exception:
            return pd.read_json(path, lines=True)
    if ext == ".parquet":
        return pd.read_parquet(path)
    raise ValueError(f"Unsupported file format: '{ext}'")


def _fail_result(msg: str, errors: list, warnings: list) -> Dict[str, Any]:
    errors.append(msg)
    return {
        "verdict":          "FAIL",
        "column_fidelity":  {},
        "range_adherence":  {},
        "cat_adherence":    {},
        "duplicate_rate":   0.0,
        "warnings":         warnings,
        "errors":           errors,
        "n_synthetic_rows": 0,
        "n_original_rows":  None,
    }
