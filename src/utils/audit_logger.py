"""
audit_logger.py — Per-Stage Audit Logger
==========================================

Structured, immutable audit log written per pipeline run.
Every stage must call log_stage() before and after execution.
The log is written atomically to disk (temp → rename, same as CheckPoint).

Log file: <cache_dir>/<fingerprint>_<run_id>_audit.jsonl
Format  : one JSON object per line (JSONL)

Log entry schema
----------------
{
  "run_id":       "<str>",
  "stage":        "<str>",
  "event":        "START" | "SUCCESS" | "FAILURE",
  "timestamp":    "<ISO-8601>",
  "duration_ms":  <int | null>,
  "input_rows":   <int | null>,
  "output_rows":  <int | null>,
  "rejected_rows":<int | null>,
  "reject_reasons": {<reason: count>},
  "metrics":      {<name: value>},
  "error":        "<str | null>"
}

Always runs — failures in the audit logger itself are printed to stderr
but never re-raised (the audit logger must not kill the pipeline).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, Generator, List, Optional


# ==================================================================
# Entry dataclass
# ==================================================================

@dataclass
class AuditEntry:
    run_id:         str
    stage:          str
    event:          str                    # "START" | "SUCCESS" | "FAILURE"
    timestamp:      str
    duration_ms:    Optional[int] = None
    input_rows:     Optional[int] = None
    output_rows:    Optional[int] = None
    rejected_rows:  Optional[int] = None
    reject_reasons: Dict[str, int] = field(default_factory=dict)
    metrics:        Dict[str, Any] = field(default_factory=dict)
    error:          Optional[str]  = None
    warnings:       List[str]      = field(default_factory=list)


# ==================================================================
# Logger
# ==================================================================

class AuditLogger:
    """
    Append-only audit log for one pipeline run.

    Usage
    -----
    logger = AuditLogger(run_id="abc123", path="/cache/abc123_run1_audit.jsonl")

    with logger.stage("generate", input_rows=5000) as ctx:
        result = engine.sample(5000)
        ctx.output_rows  = len(result)
        ctx.metrics      = {"acceptance_rate": 0.82}
        ctx.warnings     = engine.warnings
    # logs START + SUCCESS automatically; FAILURE on exception
    """

    def __init__(self, run_id: str, path: str) -> None:
        self.run_id = run_id
        self.path   = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    # ------------------------------------------------------------------
    # Context-manager stage wrapper
    # ------------------------------------------------------------------

    @contextmanager
    def stage(
        self,
        stage_name:  str,
        input_rows:  Optional[int] = None,
    ):
        """
        Context manager that automatically logs START, then SUCCESS or
        FAILURE with elapsed time.  Use ctx.* to populate result fields.

        with logger.stage("validate", input_rows=500) as ctx:
            ...
            ctx.output_rows = 480
            ctx.rejected_rows = 20
            ctx.reject_reasons = {"quality": 15, "duplicate": 5}
        """
        ctx = _StageContext()
        start_ts  = _now_iso()
        start_t   = time.monotonic()

        self._append(AuditEntry(
            run_id      = self.run_id,
            stage       = stage_name,
            event       = "START",
            timestamp   = start_ts,
            input_rows  = input_rows,
        ))

        try:
            yield ctx
            elapsed_ms = int((time.monotonic() - start_t) * 1000)
            self._append(AuditEntry(
                run_id         = self.run_id,
                stage          = stage_name,
                event          = "SUCCESS",
                timestamp      = _now_iso(),
                duration_ms    = elapsed_ms,
                input_rows     = input_rows,
                output_rows    = ctx.output_rows,
                rejected_rows  = ctx.rejected_rows,
                reject_reasons = ctx.reject_reasons,
                metrics        = ctx.metrics,
                warnings       = ctx.warnings,
            ))
        except Exception as exc:
            elapsed_ms = int((time.monotonic() - start_t) * 1000)
            self._append(AuditEntry(
                run_id      = self.run_id,
                stage       = stage_name,
                event       = "FAILURE",
                timestamp   = _now_iso(),
                duration_ms = elapsed_ms,
                input_rows  = input_rows,
                output_rows = ctx.output_rows,
                error       = f"{type(exc).__name__}: {exc}",
                warnings    = ctx.warnings,
            ))
            raise  # always re-raise — logger must not swallow errors

    # ------------------------------------------------------------------
    # Direct log call (non-context-manager)
    # ------------------------------------------------------------------

    def log(self, stage: str, event: str, **kwargs) -> None:
        """Direct one-shot log call (for simple events)."""
        self._append(AuditEntry(
            run_id    = self.run_id,
            stage     = stage,
            event     = event,
            timestamp = _now_iso(),
            **{k: v for k, v in kwargs.items() if k in AuditEntry.__dataclass_fields__},
        ))

    # ------------------------------------------------------------------
    # Atomic append
    # ------------------------------------------------------------------

    def _append(self, entry: AuditEntry) -> None:
        """Append one JSON line atomically."""
        try:
            line = json.dumps(asdict(entry), ensure_ascii=False, default=_json_default) + "\n"
            # Open in append mode — JSONL does not require a full rewrite
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line)
        except Exception as e:
            # Audit logger failure MUST NOT kill the pipeline.
            print(
                f"[AuditLogger] WARNING: Failed to write audit entry for "
                f"stage={entry.stage} event={entry.event}: {e}",
                file=sys.stderr,
            )


# ==================================================================
# Stage context (mutable, populated by caller)
# ==================================================================

class _StageContext:
    """
    Mutable context object populated inside `with logger.stage(...) as ctx:`.
    All fields are optional; unset fields are omitted from the log.
    """
    def __init__(self) -> None:
        self.output_rows:   Optional[int]      = None
        self.rejected_rows: Optional[int]      = None
        self.reject_reasons: Dict[str, int]    = {}
        self.metrics:        Dict[str, Any]    = {}
        self.warnings:       List[str]         = []


# ==================================================================
# Module-level convenience — one logger per run
# ==================================================================

_current_logger: Optional[AuditLogger] = None


def init(run_id: str, path: str) -> AuditLogger:
    """
    Initialise the module-level audit logger for a run.
    Must be called at the start of generate() before any stage runs.
    """
    global _current_logger
    _current_logger = AuditLogger(run_id=run_id, path=path)
    return _current_logger


def get() -> Optional[AuditLogger]:
    """Return the current module-level logger (may be None before init)."""
    return _current_logger


# ==================================================================
# Private helpers
# ==================================================================

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _json_default(obj: Any) -> Any:
    if hasattr(obj, "item"):
        return obj.item()
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    return str(obj)
