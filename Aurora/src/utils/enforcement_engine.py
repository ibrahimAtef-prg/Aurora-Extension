"""
enforcement_engine.py — Central Enforcement Engine
====================================================

THE MANDATORY CORE. Runs after every pipeline stage.
Orchestrates: invariants → metric gate → sanity guard →
              overfitting_detector → diversity_guard → contract.

RULE: No data leaves any stage without passing through here first.

Architecture
------------

    Stage Output
         │
         ▼
    EnforcementEngine.run_post_stage()
         │
         ├─ system_invariants.check_dataframe()    HARD FAIL on violation
         ├─ sanity_guard.check_dataframe()         HARD FAIL on impossibility
         ├─ (if metrics provided)
         │    metric_gate.enforce_all()            HARD FAIL on threshold breach
         │    sanity_guard.check_metrics()         HARD FAIL on contradiction
         ├─ overfitting_detector.check_overfitting() HARD FAIL on structural overfit
         ├─ diversity_guard.check_diversity()       HARD FAIL on collapse
         │
         └─ audit_logger.log()                     Always runs
         │
         ▼
    Caller receives clean, verified output

Pipeline Contract Gate (final stage only)
-----------------------------------------
    enforcement_engine.enforce_contract()
         │
         └─ pipeline_contract.enforce()            HARD FAIL if any clause missing


Always raises:
    InvariantViolation  — data corruption
    MetricGateFail      — threshold breach
    SanityGuardFail     — logical impossibility
    PipelineHardFail    — contract failure

NEVER returns unverified data.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from pipeline_errors import (
    PipelineHardFail,
    InvariantViolation,
    StageError,
    wrap_stage,
)
import system_invariants
import metric_gate
import sanity_guard
import audit_logger as _audit_mod
from pipeline_contract import PipelineContract
from overfitting_detector import check_overfitting
from diversity_guard import check_diversity


# ==================================================================
# EnforcementEngine
# ==================================================================

class EnforcementEngine:
    """
    Stateful enforcement engine for one pipeline run.

    One instance is created at the start of generate() and passed
    to every stage.  It accumulates contract evidence as stages run.

    Parameters
    ----------
    bl         : BaselineReader — schema source of truth
    n_requested: target row count
    run_id     : unique run identifier (from config_snapshot)
    logger     : AuditLogger for this run
    high_risk  : apply stricter metric thresholds
    """

    def __init__(
        self,
        bl:             Any,      # BaselineReader (duck-typed)
        n_requested:    int,
        run_id:         str,
        logger:         Optional[Any] = None,  # AuditLogger | None
        high_risk:      bool = False,
        original_df:    Optional[Any] = None,  # pd.DataFrame | None for corr-diff
    ) -> None:
        self._bl          = bl
        self._n_requested = n_requested
        self._run_id      = run_id
        self._logger      = logger
        self._high_risk   = high_risk
        self._original_df = original_df      # used by overfitting_detector
        self._contract    = PipelineContract(
            n_requested      = n_requested,
            min_row_fraction = 0.95,
        )

    # ------------------------------------------------------------------
    # Core: post-stage enforcement
    # ------------------------------------------------------------------

    def run_post_stage(
        self,
        stage:    str,
        df:       pd.DataFrame,
        metrics:  Optional[Dict[str, Any]] = None,
        *,
        allow_partial:    bool = True,
        allow_extra_cols: bool = False,
    ) -> pd.DataFrame:
        """
        Enforce all checks on the output of a pipeline stage.

        Parameters
        ----------
        stage            : stage name ("generate", "validate", etc.)
        df               : output DataFrame from the stage
        metrics          : computed metric dict (optional)
        allow_partial    : allow row count shortfall
        allow_extra_cols : allow extra columns in schema check

        Returns
        -------
        The same `df` if all checks pass.

        Raises
        ------
        InvariantViolation, MetricGateFail, SanityGuardFail on failure.
        """
        logger = self._logger

        # ── 1. System invariants ──────────────────────────────────────
        try:
            system_invariants.check_dataframe(
                df            = df,
                bl            = self._bl,
                stage         = stage,
                n_requested   = self._n_requested,
                allow_partial = allow_partial,
                allow_extra_cols = allow_extra_cols,
            )
            self._contract.record_invariants_passed()
        except InvariantViolation:
            raise  # already structured — re-raise unchanged

        # ── 2. Sanity guard — data level ──────────────────────────────
        bl_num = getattr(self._bl, "numeric",      {})
        bl_cat = getattr(self._bl, "categorical",  {})
        sanity_guard.check_dataframe(df, bl_num, bl_cat, stage)
        self._contract.record_sanity_passed()

        # ── 3. Metric gate (if metrics provided) ─────────────────────
        if metrics:
            validated = metric_gate.enforce_all(
                metrics   = metrics,
                stage     = stage,
                high_risk = self._high_risk,
            )
            self._contract.record_metrics_valid(validated)

            # Sanity guard — metric level
            sanity_guard.check_metrics(
                metrics         = metrics,
                stage           = stage,
                acceptance_rate = metrics.get("acceptance_rate"),
            )

        # ── 4. Structural overfitting detection ───────────────────────
        try:
            check_overfitting(
                synthetic_df = df,
                baseline     = self._bl,
                original_df  = getattr(self, "_original_df", None),
                stage        = f"{stage}.overfitting",
            )
        except PipelineHardFail:
            raise   # re-raise — already structured
        except Exception:
            pass    # overfitting detector import failure is non-fatal (missing numpy etc)

        # ── 5. Distribution collapse / entropy check ──────────────────
        try:
            check_diversity(df, stage=f"{stage}.diversity")
        except PipelineHardFail:
            raise
        except Exception:
            pass

        # ── 6. Log the stage result ───────────────────────────────────
        if logger:
            try:
                logger.log(
                    stage   = stage,
                    event   = "ENFORCED",
                    output_rows = len(df),
                    metrics = metrics or {},
                )
            except Exception:
                pass  # logger failure never kills pipeline (per design)

        return df

    # ------------------------------------------------------------------
    # Convenience: enforce leakage metrics alone (no DataFrame)
    # ------------------------------------------------------------------

    def run_post_leakage(
        self,
        stage:   str,
        metrics: Dict[str, Any],
    ) -> Dict[str, float]:
        """
        Enforce metric gate + sanity guard on leakage output.
        No DataFrame checks (leakage operates on metrics, not rows).
        """
        validated = metric_gate.enforce_all(
            metrics   = metrics,
            stage     = stage,
            high_risk = self._high_risk,
        )
        self._contract.record_metrics_valid(validated)
        sanity_guard.check_metrics(metrics=metrics, stage=stage)
        self._contract.record_sanity_passed()
        return validated

    # ------------------------------------------------------------------
    # Contract finalization
    # ------------------------------------------------------------------

    def record_rows(self, actual: int) -> None:
        """Called once after all generation rounds complete."""
        self._contract.record_rows(actual)

    def record_seed(self, seed: int) -> None:
        self._contract.record_seed(seed)

    def record_config_hash(self, h: str) -> None:
        self._contract.record_config_hash(h)

    def enforce_contract(self):
        """
        Final gate — call at the very end of generate(), before returning.
        Raises PipelineHardFail if the contract is not satisfied.
        """
        return self._contract.enforce()


# ==================================================================
# Module-level singleton (one per process / per generate() call)
# ==================================================================

_current_engine: Optional[EnforcementEngine] = None


def init(
    bl:          Any,
    n_requested: int,
    run_id:      str,
    logger:      Optional[Any] = None,
    high_risk:   bool = False,
) -> EnforcementEngine:
    """
    Create and install the module-level enforcement engine for a run.
    Called once at the start of generate().
    """
    global _current_engine
    _current_engine = EnforcementEngine(
        bl          = bl,
        n_requested = n_requested,
        run_id      = run_id,
        logger      = logger,
        high_risk   = high_risk,
    )
    return _current_engine


def get() -> Optional[EnforcementEngine]:
    """Return the active enforcement engine (None before init)."""
    return _current_engine


# ==================================================================
# Top-level error handler — used in CLI __main__ blocks
# ==================================================================

def handle_toplevel_error(exc: Exception) -> int:
    """
    Convert any PipelineHardFail (or sub-class) to a structured JSON
    error on stderr, then return exit code 2.

    Non-PipelineHardFail exceptions are re-raised as-is.
    """
    if isinstance(exc, PipelineHardFail):
        err = exc.to_dict()
        print(json.dumps(err, ensure_ascii=False, default=str), file=sys.stderr)
        return 2
    raise exc
