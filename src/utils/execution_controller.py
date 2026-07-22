"""
execution_controller.py — Backpressure & Concurrency Control
=============================================================

Limits concurrent pipeline runs and enforces a bounded FIFO queue.
Prevents unbounded resource consumption and system collapse under load.

Architecture
------------
    ExecutionController (singleton per process)
        ├── Semaphore(MAX_CONCURRENT_RUNS)
        ├── FIFO queue (bounded)
        └── run_registry: {run_id → status}

Usage (in generate())
---------------------
    from execution_controller import acquire_slot, release_slot

    slot = acquire_slot(run_id, timeout=30)
    try:
        result = _run_pipeline(...)
    finally:
        release_slot(slot)

Usage (as context manager)
--------------------------
    from execution_controller import pipeline_slot

    with pipeline_slot(run_id):
        result = _run_pipeline(...)

Configuration (env vars)
------------------------
    AUTOMATE_MAX_CONCURRENT   : max parallel runs (default 3)
    AUTOMATE_QUEUE_TIMEOUT    : seconds to wait for a slot (default 60)
    AUTOMATE_MAX_QUEUE_DEPTH  : max queued requests (default 10)
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Dict, Iterator, Optional

from pipeline_errors import PipelineHardFail


# ==================================================================
# Configuration
# ==================================================================

_MAX_CONCURRENT  = int(os.environ.get("AUTOMATE_MAX_CONCURRENT",  "3"))
_QUEUE_TIMEOUT   = float(os.environ.get("AUTOMATE_QUEUE_TIMEOUT", "60"))
_MAX_QUEUE_DEPTH = int(os.environ.get("AUTOMATE_MAX_QUEUE_DEPTH", "10"))


# ==================================================================
# Slot token
# ==================================================================

@dataclass
class PipelineSlot:
    """Returned by acquire_slot(). Must be passed to release_slot()."""
    run_id:     str
    slot_id:    str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    acquired_at: float = field(default_factory=time.monotonic)

    @property
    def wait_seconds(self) -> float:
        return time.monotonic() - self.acquired_at


# ==================================================================
# Controller singleton
# ==================================================================

class _ExecutionController:
    """
    Thread-safe FIFO semaphore with queue depth limiting.
    """

    def __init__(
        self,
        max_concurrent: int  = _MAX_CONCURRENT,
        max_queue:      int  = _MAX_QUEUE_DEPTH,
    ) -> None:
        self._sem       = threading.Semaphore(max_concurrent)
        self._max_concurrent = max_concurrent
        self._max_queue = max_queue
        self._lock      = threading.Lock()
        self._queue:    list[str] = []          # run_ids waiting for slot
        self._active:   Dict[str, PipelineSlot] = {}   # run_id → slot
        self._stats     = {"acquired": 0, "rejected": 0, "timed_out": 0}

    # ── Acquire ───────────────────────────────────────────────────

    def acquire(
        self,
        run_id:  str,
        timeout: float = _QUEUE_TIMEOUT,
    ) -> PipelineSlot:
        """
        Acquire a pipeline execution slot.

        If MAX_CONCURRENT runs are active, block until a slot frees up
        or timeout expires. If queue is full, reject immediately.

        Parameters
        ----------
        run_id  : unique identifier for this pipeline run
        timeout : seconds to wait before raising PipelineHardFail

        Returns
        -------
        PipelineSlot token (must be passed to release())

        Raises
        ------
        PipelineHardFail : queue at capacity (immediate rejection)
        PipelineHardFail : timeout waiting for an available slot
        """
        with self._lock:
            active_count = len(self._active)
            queue_depth  = len(self._queue)

            if active_count >= self._max_concurrent:
                if queue_depth >= self._max_queue:
                    self._stats["rejected"] += 1
                    raise PipelineHardFail(
                        message = (
                            f"BACKPRESSURE: Execution queue is full. "
                            f"Active runs: {active_count}/{self._max_concurrent}, "
                            f"Queue depth: {queue_depth}/{self._max_queue}. "
                            f"Run '{run_id}' was rejected. Retry later."
                        ),
                        stage   = "execution_controller",
                        context = {
                            "run_id":       run_id,
                            "active_count": active_count,
                            "queue_depth":  queue_depth,
                        },
                    )
                self._queue.append(run_id)

        # Block waiting for a slot
        deadline = time.monotonic() + timeout
        acquired = self._sem.acquire(timeout=max(0.0, deadline - time.monotonic()))

        with self._lock:
            if run_id in self._queue:
                self._queue.remove(run_id)

        if not acquired:
            self._stats["timed_out"] += 1
            raise PipelineHardFail(
                message = (
                    f"BACKPRESSURE: Timeout waiting for pipeline slot after "
                    f"{timeout:.0f}s. Run '{run_id}' was not started. "
                    f"System may be overloaded."
                ),
                stage   = "execution_controller",
                context = {"run_id": run_id, "timeout": timeout},
            )

        with self._lock:
            slot                = PipelineSlot(run_id=run_id)
            self._active[run_id] = slot
            self._stats["acquired"] += 1

        return slot

    # ── Release ───────────────────────────────────────────────────

    def release(self, slot: PipelineSlot) -> None:
        """Release a pipeline slot previously acquired with acquire()."""
        with self._lock:
            self._active.pop(slot.run_id, None)
        self._sem.release()

    # ── Context manager ───────────────────────────────────────────

    @contextmanager
    def slot(
        self,
        run_id:  str,
        timeout: float = _QUEUE_TIMEOUT,
    ) -> Iterator[PipelineSlot]:
        """Context manager: acquire → yield slot → release (even on exception)."""
        s = self.acquire(run_id, timeout)
        try:
            yield s
        finally:
            self.release(s)

    # ── Stats ─────────────────────────────────────────────────────

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._active)

    @property
    def queue_depth(self) -> int:
        with self._lock:
            return len(self._queue)

    def stats(self) -> dict:
        with self._lock:
            return {
                **self._stats,
                "active":       list(self._active.keys()),
                "queued":       list(self._queue),
                "max_concurrent": self._max_concurrent,
                "max_queue":    self._max_queue,
            }


# ==================================================================
# Process-level singleton
# ==================================================================

_CONTROLLER = _ExecutionController()


# ==================================================================
# Public helpers
# ==================================================================

def acquire_slot(run_id: str, timeout: float = _QUEUE_TIMEOUT) -> PipelineSlot:
    """Acquire a pipeline slot from the process-level controller."""
    return _CONTROLLER.acquire(run_id, timeout)


def release_slot(slot: PipelineSlot) -> None:
    """Release a slot acquired with acquire_slot()."""
    _CONTROLLER.release(slot)


@contextmanager
def pipeline_slot(run_id: str, timeout: float = _QUEUE_TIMEOUT) -> Iterator[PipelineSlot]:
    """Context manager: acquire, yield slot, always release."""
    with _CONTROLLER.slot(run_id, timeout) as s:
        yield s


def controller_stats() -> dict:
    """Return current controller state for monitoring."""
    return _CONTROLLER.stats()
