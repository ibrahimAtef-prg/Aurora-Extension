"""
leakage_gate.py — Hard Leakage Enforcement Gate
=================================================

Called AFTER evaluation and BEFORE final_decision.
Enforces privacy thresholds on leakage metrics.
On any violation: raises PipelineHardFail immediately.
NO soft-fail. NO uncertainty_notes. NO continuation.

Thresholds
----------
    duplicates_rate      > 0.10  → HARD FAIL  (>10% exact copies = data leakage)
    privacy_score        < 0.30  → HARD FAIL  (<30% privacy = critical exposure)
    membership_inference_auc > 0.75 → HARD FAIL  (>0.75 = membership attack succeeds)

These are conservative defaults. They can be overridden via enforce_leakage(metrics, config).
"""

from __future__ import annotations

import math
from typing import Any, Dict, Optional

from pipeline_errors import PipelineHardFail, MetricGateFail


# ==================================================================
# Default thresholds (all inclusive boundaries)
# ==================================================================

_MAX_DUPLICATES_RATE   = 0.10   # > 10% exact copies is a hard data leak
_MIN_PRIVACY_SCORE     = 0.30   # < 30% privacy = critical privacy violation
_MAX_MI_AUC            = 0.75   # > 0.75 AUC = membership inference succeeds reliably


# ==================================================================
# Core enforcement function
# ==================================================================

def enforce_leakage(
    metrics:         Dict[str, Any],
    stage:           str = "leakage_gate",
    max_dup_rate:    float = _MAX_DUPLICATES_RATE,
    min_privacy:     float = _MIN_PRIVACY_SCORE,
    max_mi_auc:      float = _MAX_MI_AUC,
) -> None:
    """
    Enforce hard leakage thresholds.

    Parameters
    ----------
    metrics      : leakage metrics dict from leakage_bridge or CheckPoint
                   Expected keys: duplicates_rate, privacy_score,
                                  membership_inference_auc
    stage        : stage name for error context
    max_dup_rate : maximum allowed exact-duplicate rate (0.0–1.0)
    min_privacy  : minimum required privacy score (0.0–1.0)
    max_mi_auc   : maximum allowed membership inference AUC (0.0–1.0)

    Raises
    ------
    PipelineHardFail on ANY threshold violation.
    """
    # ── 1. Duplicates rate ───────────────────────────────────────
    dup_rate = metrics.get("duplicates_rate")
    if dup_rate is not None:
        _assert_finite(dup_rate, "duplicates_rate", stage)
        if float(dup_rate) > max_dup_rate:
            raise PipelineHardFail(
                message = (
                    f"LEAKAGE VIOLATION: duplicates_rate={dup_rate:.4f} "
                    f"exceeds hard limit of {max_dup_rate:.2f}. "
                    f"Synthetic data contains too many exact copies of training rows — "
                    f"release would directly leak private training data."
                ),
                stage   = stage,
                context = {
                    "metric":    "duplicates_rate",
                    "value":     float(dup_rate),
                    "threshold": max_dup_rate,
                },
            )

    # ── 2. Privacy score ─────────────────────────────────────────
    privacy_score = metrics.get("privacy_score")
    if privacy_score is not None:
        _assert_finite(privacy_score, "privacy_score", stage)
        if float(privacy_score) < min_privacy:
            raise PipelineHardFail(
                message = (
                    f"PRIVACY VIOLATION: privacy_score={privacy_score:.4f} "
                    f"is below minimum required {min_privacy:.2f}. "
                    f"Dataset has critically insufficient privacy protection."
                ),
                stage   = stage,
                context = {
                    "metric":    "privacy_score",
                    "value":     float(privacy_score),
                    "threshold": min_privacy,
                },
            )

    # ── 3. Membership inference AUC ──────────────────────────────
    mi_auc = metrics.get("membership_inference_auc")
    if mi_auc is not None:
        _assert_finite(mi_auc, "membership_inference_auc", stage)
        if float(mi_auc) > max_mi_auc:
            raise PipelineHardFail(
                message = (
                    f"MEMBERSHIP INFERENCE RISK: membership_inference_auc={mi_auc:.4f} "
                    f"exceeds hard limit of {max_mi_auc:.2f}. "
                    f"An attacker can reliably determine whether records were in the "
                    f"training set — release would violate membership privacy."
                ),
                stage   = stage,
                context = {
                    "metric":    "membership_inference_auc",
                    "value":     float(mi_auc),
                    "threshold": max_mi_auc,
                },
            )


def _assert_finite(value: Any, name: str, stage: str) -> None:
    """Raise PipelineHardFail if value is not a finite number."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        raise PipelineHardFail(
            message = f"LEAKAGE GATE: metric '{name}' is not numeric: {value!r}",
            stage   = stage,
        )
    if math.isnan(f) or math.isinf(f):
        raise PipelineHardFail(
            message = f"LEAKAGE GATE: metric '{name}' is non-finite: {f}",
            stage   = stage,
            context = {"metric": name, "value": repr(f)},
        )
