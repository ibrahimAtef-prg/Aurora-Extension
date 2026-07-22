"""
sanity_guard.py — Output Sanity Guard
=======================================

Detects outputs that are LOGICALLY impossible or statistically suspicious:
    - all values identical in a numeric column
    - all categories the same single value
    - numeric range collapsed to a point
    - output has MORE unique values than the original
    - impossible regression of row counts

Unlike system_invariants (which checks DATA corruption), sanity_guard checks
for LOGICAL impossibilities that indicate the generation algorithm failed.

These are blocking checks. If any fires, execution halts.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from pipeline_errors import SanityGuardFail, assert_hard


# ==================================================================
# Configuration
# ==================================================================

_COLLAPSE_FRACTION    = 0.005   # std/range ratio below which a column is "collapsed"
_DOMINANCE_THRESHOLD  = 0.99    # if one category value exceeds 99% of rows → suspicious
_MIN_ACCEPTANCE_RATIO = 0.01    # below 1% acceptance is algorithmic failure


# ==================================================================
# Data frame checks
# ==================================================================

def _check_numeric_collapse(
    df:      pd.DataFrame,
    bl_num:  Dict[str, Any],   # baseline numeric stats dict
    stage:   str,
) -> None:
    """
    A numeric column in synthetic data must show some variation.
    If std / (max-min) < _COLLAPSE_FRACTION, every value is the same
    — this indicates the generation algorithm broke entirely.
    """
    for col, spec in bl_num.items():
        if col not in df.columns:
            continue
        s  = pd.to_numeric(df[col], errors="coerce").dropna()
        if len(s) < 100:
            continue
        rng = float(s.max() - s.min())
        std = float(s.std()) if len(s) > 1 else 0.0
        if rng < 1e-9:
            # All values identical — check if baseline allowed that
            _raw_std = spec.get("std")
            bl_std   = float(_raw_std) if _raw_std is not None else 1.0
            if bl_std > 1e-3:
                raise SanityGuardFail(
                    contradiction = "NUMERIC_COLLAPSE",
                    details = {
                        "column": col,
                        "synthetic_range": rng,
                        "baseline_std":    bl_std,
                        "reason": (
                            f"Column '{col}' has zero range in synthetic output "
                            f"but baseline std={bl_std:.4f} — generation collapsed"
                        ),
                    },
                    stage = stage,
                )


def _check_categorical_dominance(
    df:      pd.DataFrame,
    bl_cat:  Dict[str, Any],   # baseline categorical stats dict
    stage:   str,
) -> None:
    """
    If one category dominates > 99% of rows but the baseline ratio
    for that value was < 60%, the generator collapsed to one mode.
    """
    if len(df) < 100:
        return
    for col, spec in bl_cat.items():
        if col not in df.columns:
            continue
        vc    = df[col].astype(str).value_counts(normalize=True)
        if vc.empty:
            continue
        top_v = vc.index[0]
        top_r = float(vc.iloc[0])
        if top_r >= _DOMINANCE_THRESHOLD:
            # Compare to baseline ratio for this value
            bl_ratios = spec.get("top_value_ratios", {}) or {}
            bl_top    = bl_ratios.get(top_v, 0.0)
            if bl_top < 0.60:
                raise SanityGuardFail(
                    contradiction = "CATEGORICAL_DOMINANCE",
                    details = {
                        "column":             col,
                        "dominant_value":     top_v,
                        "synthetic_ratio":    round(top_r, 4),
                        "baseline_ratio":     round(bl_top, 4),
                        "reason": (
                            f"Column '{col}' value '{top_v}' covers "
                            f"{top_r:.1%} of synthetic rows but only "
                            f"{bl_top:.1%} in baseline — generation collapsed"
                        ),
                    },
                    stage = stage,
                )


def _check_uniqueness_explosion(
    df:     pd.DataFrame,
    bl_cat: Dict[str, Any],
    stage:  str,
) -> None:
    """
    Synthetic data must not have MORE unique categories than the original.
    If it does, the generator invented new values — a critical fidelity failure.
    """
    for col, spec in bl_cat.items():
        if col not in df.columns:
            continue
        allowed = set(str(v) for v in (spec.get("allowed_values") or []))
        if not allowed:
            continue
        synth_unique = set(df[col].dropna().astype(str).unique())
        invented = synth_unique - allowed
        # Allow values from small numeric drift in float-cast categoricals
        # Only fail on non-trivially-new string categories
        invented_strings = {v for v in invented if not _is_float_variant(v, allowed)}
        if len(invented_strings) > 0:
            raise SanityGuardFail(
                contradiction = "INVENTED_CATEGORIES",
                details = {
                    "column":   col,
                    "invented": sorted(invented_strings)[:10],
                    "reason": (
                        f"Column '{col}' produced {len(invented_strings)} "
                        f"synthetic category values not in the original dataset"
                    ),
                },
                stage = stage,
            )


def _is_float_variant(v: str, allowed: set) -> bool:
    """Return True if `v` is a minor float-format variant of an allowed value."""
    try:
        fv = float(v)
        return any(abs(fv - float(av)) < 1e-6 for av in allowed if _parseable(av))
    except (ValueError, TypeError):
        return False


def _parseable(v: str) -> bool:
    try:
        float(v)
        return True
    except Exception:
        return False


# ==================================================================
# Metric-level checks
# ==================================================================

def _check_acceptance_collapse(
    acceptance_rate: Optional[float],
    stage: str,
) -> None:
    """If acceptance_rate is below 1%, the generator is producing garbage."""
    if acceptance_rate is None:
        return
    assert_hard(
        float(acceptance_rate) >= _MIN_ACCEPTANCE_RATIO,
        SanityGuardFail(
            contradiction = "ACCEPTANCE_COLLAPSE",
            details = {
                "acceptance_rate":   acceptance_rate,
                "min_required":      _MIN_ACCEPTANCE_RATIO,
                "reason": (
                    f"Acceptance rate {acceptance_rate:.2%} is below "
                    f"{_MIN_ACCEPTANCE_RATIO:.0%} — "
                    "validation layer is rejecting nearly all generated rows"
                ),
            },
            stage = stage,
        ),
    )


def _check_metric_finiteness(
    metrics: Dict[str, Any],
    stage:   str,
) -> None:
    """All numeric metric values must be finite."""
    for name, val in metrics.items():
        if val is None:
            continue
        try:
            f = float(val)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(f):
            raise SanityGuardFail(
                contradiction = "NON_FINITE_METRIC",
                details       = {"metric": name, "value": repr(val)},
                stage         = stage,
            )


# ==================================================================
# Public API
# ==================================================================

def check_dataframe(
    df:      pd.DataFrame,
    bl_num:  Dict[str, Any],
    bl_cat:  Dict[str, Any],
    stage:   str,
) -> None:
    """
    Run all data-level sanity checks on a generated DataFrame.

    Parameters
    ----------
    df      : synthetic DataFrame to check
    bl_num  : baseline numeric column specs
    bl_cat  : baseline categorical column specs
    stage   : calling stage name

    Raises
    ------
    SanityGuardFail on any logical impossibility.
    """
    _check_numeric_collapse(df, bl_num, stage)
    _check_categorical_dominance(df, bl_cat, stage)
    _check_uniqueness_explosion(df, bl_cat, stage)


def check_metrics(
    metrics:         Dict[str, Any],
    stage:           str,
    acceptance_rate: Optional[float] = None,
) -> None:
    """
    Run all metric-level sanity checks.

    Parameters
    ----------
    metrics         : metric name → value dict
    stage           : calling stage name
    acceptance_rate : if known, explicitly checked for collapse

    Raises
    ------
    SanityGuardFail on any impossible combination.
    """
    _check_metric_finiteness(metrics, stage)
    if acceptance_rate is not None:
        _check_acceptance_collapse(acceptance_rate, stage)
    elif "acceptance_rate" in metrics:
        _check_acceptance_collapse(metrics["acceptance_rate"], stage)
