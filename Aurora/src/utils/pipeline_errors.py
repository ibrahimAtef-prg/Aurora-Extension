"""
pipeline_errors.py — Structured Error Hierarchy for AutoMate Pipeline
======================================================================

ALL pipeline failures are expressed through this hierarchy.
No bare `except: pass` or generic strings allowed at stage boundaries.

Usage
-----
    from pipeline_errors import PipelineHardFail, StageError, InvariantViolation

Hierarchy
---------
    PipelineHardFail          ← top-level: pipeline must stop immediately
      ├── InvariantViolation  ← schema / NaN / column order data corruption
      ├── MetricGateFail      ← enforced metric threshold exceeded
      ├── SanityGuardFail     ← impossible/contradictory metric combination
      ├── ConfigError         ← immutable config was violated or missing
      └── StageError          ← a named pipeline stage failed
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# ==================================================================
# Base
# ==================================================================

class PipelineHardFail(Exception):
    """
    Raised whenever a pipeline execution must halt unconditionally.
    Any uncaught PipelineHardFail exits the Python process with code 2
    and serialises a structured JSON error object to stderr so the
    extension.ts runner can surface it accurately.
    """

    def __init__(
        self,
        message: str,
        stage:   str                   = "unknown",
        context: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.stage   = stage
        self.context = context or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "error_type": type(self).__name__,
            "stage":      self.stage,
            "message":    str(self),
            "context":    self.context,
        }


# ==================================================================
# Concrete sub-classes
# ==================================================================

class InvariantViolation(PipelineHardFail):
    """
    Raised when a system invariant (NaN, schema mismatch, column order,
    row count, categorical validity) is violated in the data.
    This is a data-corruption class error — always fatal.
    """

    def __init__(
        self,
        invariant: str,
        detail:    str,
        stage:     str = "invariant_check",
        context:   Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(
            message = f"InvariantViolation[{invariant}]: {detail}",
            stage   = stage,
            context = context or {},
        )
        self.invariant = invariant
        self.detail    = detail


class MetricGateFail(PipelineHardFail):
    """
    Raised when a metric exceeds its enforced threshold, making
    the output invalid by policy.
    """

    def __init__(
        self,
        metric:    str,
        value:     float,
        threshold: float,
        direction: str  = "above",   # "above" | "below"
        stage:     str  = "metric_gate",
        context:   Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(
            message = (
                f"MetricGateFail[{metric}]: value={value:.6f} "
                f"is {direction} threshold={threshold:.6f}"
            ),
            stage   = stage,
            context = context or {},
        )
        self.metric    = metric
        self.value     = value
        self.threshold = threshold
        self.direction = direction


class SanityGuardFail(PipelineHardFail):
    """
    Raised when computed metrics form an impossible or contradictory
    combination that signals corrupt computation (e.g., high privacy
    score + near-zero MI-AUC simultaneously).
    """

    def __init__(
        self,
        contradiction: str,
        details:       Dict[str, Any],
        stage:         str = "sanity_guard",
    ) -> None:
        super().__init__(
            message = f"SanityGuardFail: {contradiction}",
            stage   = stage,
            context = details,
        )
        self.contradiction = contradiction
        self.details       = details


class ConfigError(PipelineHardFail):
    """
    Raised when an immutable run configuration is missing, invalid,
    or has been mutated after being frozen.
    """

    def __init__(self, detail: str, stage: str = "config") -> None:
        super().__init__(message=f"ConfigError: {detail}", stage=stage)


class StageError(PipelineHardFail):
    """
    Raised by any named pipeline stage (parse, baseline, generate,
    validate, leakage) when it encounters an unrecoverable internal
    error that is NOT a data-corruption invariant violation.
    """

    def __init__(
        self,
        stage:     str,
        message:   str,
        cause:     Optional[Exception] = None,
        context:   Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message=message, stage=stage, context=context or {})
        self.cause = cause

    def __str__(self) -> str:
        base = super().__str__()
        if self.cause:
            return f"{base} [caused by: {type(self.cause).__name__}: {self.cause}]"
        return base


# ==================================================================
# Helpers used by enforcement modules
# ==================================================================

def assert_hard(condition: bool, error: PipelineHardFail) -> None:
    """
    Raise `error` if `condition` is False.
    Semantics: assert_hard(is_valid, InvariantViolation(...))

    This is the canonical way to perform gated checks throughout the
    enforcement engine — no `if not x: raise ...` scattered everywhere.
    """
    if not condition:
        raise error


def wrap_stage(stage_name: str, fn, *args, **kwargs):
    """
    Execute fn(*args, **kwargs), converting any non-PipelineHardFail
    exception into a StageError so the caller always sees a typed error.

    Usage:
        result = wrap_stage("generate", engine.sample, n=500)
    """
    try:
        return fn(*args, **kwargs)
    except PipelineHardFail:
        raise  # re-raise typed errors unchanged
    except Exception as e:
        raise StageError(
            stage   = stage_name,
            message = f"Unhandled exception in stage '{stage_name}': {e}",
            cause   = e,
        ) from e
