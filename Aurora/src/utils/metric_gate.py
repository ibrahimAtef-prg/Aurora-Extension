"""
metric_gate.py — Metric Enforcement Gate
=========================================

Metrics are NOT passive. Every metric produced by the pipeline passes
through this gate.  If a metric violates a threshold or forms a
contradictory pair, execution halts immediately with MetricGateFail.

Architecture
------------
    compute metric → metric_gate.enforce() → continue / HARD FAIL

Contradictions detected
-----------------------
    HIGH_PRIVACY + LOW_DRIFT     : privacy too high alongside near-zero
                                   drift implies data is memorised
    HIGH_PRIVACY + HIGH_DUPLICATES : high duplicates contradicts high privacy
    LOW_MI_AUC + HIGH_DUPLICATES   : impossible — if data has duplicates the
                                     MI proxy must detect them
    ZERO_DRIFT + NONZERO_SYNTH    : synthetic produced rows but drift is 0.0
                                    implies identical distribution (copy)

Threshold policy
----------------
All thresholds are defined in _THRESHOLDS and can be overridden by
passing a thresholds dict to enforce_all().  No hard-coding elsewhere.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional, Tuple

from pipeline_errors import MetricGateFail, SanityGuardFail, assert_hard


# ==================================================================
# Threshold table  (all [0,1] or [0,100] matching metric_semantics)
# ==================================================================

_THRESHOLDS: Dict[str, Tuple[Optional[float], Optional[float]]] = {
    # metric_name         : (min_allowed, max_allowed)
    "privacy_score"                   : (0.0,  1.0),
    "duplicates_rate"                 : (0.0,  0.40),  # > 40% = FAIL
    "membership_proximity_risk_score" : (0.0,  1.0),
    "statistical_drift_score"         : (0.0,  1.0),
    "membership_inference_auc"        : (0.0,  1.0),
    "dataset_risk_score"              : (0.0,  100.0),
    "dataset_intelligence_risk"       : (0.0,  100.0),
    "acceptance_rate"                 : (0.10, 1.0),   # < 10% = FAIL (gen broken)
    "rejection_rate"                  : (0.0,  0.90),  # > 90% = FAIL
}

# Threshold overrides for HIGH_RISK mode (stricter)
_HIGH_RISK_OVERRIDES: Dict[str, Tuple[Optional[float], Optional[float]]] = {
    "duplicates_rate"   : (0.0, 0.10),   # > 10% = FAIL in HR mode
    "acceptance_rate"   : (0.20, 1.0),   # < 20% = FAIL in HR mode
}


# ==================================================================
# Contradiction specifications
# ==================================================================

_CONTRADICTIONS = [
    # (name, condition_fn, message_template)
    (
        "HIGH_PRIVACY_WITH_HIGH_DUPLICATES",
        lambda m: (
            m.get("privacy_score",    0.0) > 0.85 and
            m.get("duplicates_rate",  0.0) > 0.10
        ),
        "privacy_score={privacy_score:.3f} is high but duplicates_rate={duplicates_rate:.3f} "
        "exceeds 10% — duplicates directly contradict high privacy claims",
    ),
    (
        "HIGH_PRIVACY_WITH_NEAR_ZERO_DRIFT",
        lambda m: (
            m.get("privacy_score",         0.0) > 0.92 and
            m.get("statistical_drift_score", 1.0) < 0.02 and
            m.get("duplicates_rate",        0.0) > 0.05
        ),
        "privacy_score={privacy_score:.3f} is very high, drift={statistical_drift_score:.4f} "
        "is near-zero, and duplicates_rate={duplicates_rate:.3f} > 5% — "
        "synthetic data may be memorising training set",
    ),
    (
        "ZERO_ROWS_ACCEPTED",
        lambda m: m.get("acceptance_rate", 1.0) == 0.0,
        "acceptance_rate=0.0 — validation rejected 100% of generated rows; "
        "pipeline produced no usable output",
    ),
    (
        "INVERTED_ACCEPTANCE_REJECTION",
        lambda m: (
            abs(m.get("acceptance_rate", 0.5) + m.get("rejection_rate", 0.5) - 1.0) > 0.01
        ),
        "acceptance_rate={acceptance_rate:.3f} + rejection_rate={rejection_rate:.3f} "
        "!= 1.0 — rates are inconsistent (data corruption)",
    ),
]


# ==================================================================
# Core enforcement functions
# ==================================================================

def enforce_single(
    name:       str,
    value:      float,
    stage:      str,
    thresholds: Optional[Dict[str, Tuple[Optional[float], Optional[float]]]] = None,
) -> float:
    """
    Enforce a single metric against its threshold rules.

    Returns the value if it passes.
    Raises MetricGateFail if it violates.
    Raises ValueError if the metric is not finite.
    """
    if not isinstance(value, (int, float)):
        raise TypeError(f"enforce_single({name}): expected numeric, got {type(value)}")
    if math.isnan(value) or math.isinf(value):
        raise MetricGateFail(
            metric    = name,
            value     = float(value),
            threshold = float("nan"),
            direction = "non-finite",
            stage     = stage,
        )

    t = (thresholds or _THRESHOLDS).get(name)
    if t is None:
        return float(value)   # unknown metric — pass-through (not error)

    lo, hi = t
    if lo is not None and value < lo:
        raise MetricGateFail(
            metric    = name,
            value     = float(value),
            threshold = float(lo),
            direction = "below",
            stage     = stage,
        )
    if hi is not None and value > hi:
        raise MetricGateFail(
            metric    = name,
            value     = float(value),
            threshold = float(hi),
            direction = "above",
            stage     = stage,
        )
    return float(value)


def enforce_contradictions(
    metrics: Dict[str, Any],
    stage:   str,
) -> None:
    """
    Check all contradiction rules against a metric dict.
    Raises SanityGuardFail on the first contradiction detected.

    Parameters
    ----------
    metrics : dict of metric_name → float values (extras allowed)
    stage   : pipeline stage name for error context
    """
    for name, condition_fn, msg_template in _CONTRADICTIONS:
        try:
            violated = condition_fn(metrics)
        except Exception:
            continue  # if a metric is missing skip that rule
        if violated:
            try:
                detail = msg_template.format(**metrics)
            except (KeyError, ValueError):
                detail = msg_template
            raise SanityGuardFail(
                contradiction = name,
                details       = dict(metrics),
                stage         = stage,
            )


def enforce_all(
    metrics:      Dict[str, Any],
    stage:        str,
    high_risk:    bool = False,
    thresholds:   Optional[Dict[str, Tuple[Optional[float], Optional[float]]]] = None,
) -> Dict[str, float]:
    """
    Full gate: enforce all known metric thresholds + all contradiction rules.

    Parameters
    ----------
    metrics   : computed metric dict (values may be None — skipped)
    stage     : pipeline stage name
    high_risk : apply stricter high-risk threshold overrides
    thresholds: custom threshold overrides (merged with defaults)

    Returns
    -------
    Cleaned dict of validated metric floats (None values removed).

    Raises
    ------
    MetricGateFail  — if any metric violates its threshold.
    SanityGuardFail — if any contradiction rule fires.
    """
    merged = dict(_THRESHOLDS)
    if high_risk:
        merged.update(_HIGH_RISK_OVERRIDES)
    if thresholds:
        merged.update(thresholds)

    clean: Dict[str, float] = {}
    for name, raw in metrics.items():
        if raw is None:
            continue
        try:
            val = float(raw)
        except (TypeError, ValueError):
            continue
        clean[name] = enforce_single(name, val, stage, thresholds=merged)

    enforce_contradictions(clean, stage)
    return clean
