"""
drift_store.py — Cross-Run Historical Drift Tracking (M03)
===========================================================

Stores per-run distribution snapshots in a rolling historical store
and computes drift between consecutive runs.

Architecture
------------
    <cache_dir>/drift_store/
        <fingerprint>_history.jsonl   — one JSON line per run
        <fingerprint>_latest.json     — last run snapshot (fast lookup)

Each snapshot captures:
    - run_id, timestamp, seed, n_rows
    - per-column stats: mean, std, quantiles (numeric)
    - per-column stats: top-N value frequencies (categorical)

Drift detection
---------------
    compare_to_latest(snapshot) → DriftReport
    if drift > threshold → DriftReport.has_warning (logged, not hard fail)
    if drift > critical_threshold → raises PipelineHardFail

Usage
-----
    from drift_store import DriftStore

    store = DriftStore(cache_dir="/tmp/cache", fingerprint="abc123")

    snapshot = store.build_snapshot(synthetic_df, run_id, seed)
    report   = store.compare_and_record(snapshot, synthetic_df)

    if report.has_critical_drift:
        raise PipelineHardFail(...)   # already raised inside compare_and_record
"""

from __future__ import annotations

import json
import math
import os
import tempfile
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from pipeline_errors import PipelineHardFail


# ==================================================================
# Thresholds
# ==================================================================

_WARN_DRIFT_THRESHOLD     = 0.25   # JS > 0.25 → warning
_CRITICAL_DRIFT_THRESHOLD = 0.55   # JS > 0.55 → hard fail
_MAX_HISTORY_ENTRIES      = 50     # rolling window
# Categorical columns with more unique values than this cap are skipped
# during snapshot building.  High-cardinality categoricals (e.g. email
# addresses, free-form strings decoded back from the encoder) produce
# disjoint top-N frequency maps across runs regardless of true drift,
# making JS divergence always ≈ log(2) — an unreliable false positive.
_CATEGORICAL_CARDINALITY_CAP = 100


# ==================================================================
# Data classes
# ==================================================================

@dataclass
class RunSnapshot:
    """Distribution summary for one pipeline run."""
    run_id:     str
    timestamp:  str
    seed:       Optional[int]
    n_rows:     int
    fingerprint: str
    column_stats: Dict[str, Any] = field(default_factory=dict)


@dataclass
class DriftReport:
    """Result of comparing current snapshot to historical latest."""
    run_id:          str
    previous_run_id: Optional[str]
    column_drifts:   Dict[str, float]    # col → JS divergence
    max_drift:       float
    avg_drift:       float
    drifted_columns: List[str]
    has_warning:     bool
    has_critical_drift: bool
    message:         str


# ==================================================================
# DriftStore
# ==================================================================

class DriftStore:
    """
    Persistent, rolling historical store for cross-run drift detection.
    """

    def __init__(
        self,
        cache_dir:   str,
        fingerprint: str,
    ) -> None:
        self._dir         = os.path.join(cache_dir, "drift_store")
        self._fingerprint = fingerprint
        self._hist_path   = os.path.join(self._dir, f"{fingerprint}_history.jsonl")
        self._latest_path = os.path.join(self._dir, f"{fingerprint}_latest.json")
        os.makedirs(self._dir, exist_ok=True)

    # ── Public API ────────────────────────────────────────────────

    def build_snapshot(
        self,
        df:        pd.DataFrame,
        run_id:    str,
        seed:      Optional[int] = None,
        skip_cols: Optional[set] = None,
    ) -> RunSnapshot:
        """Build a distribution snapshot from a DataFrame.

        Parameters
        ----------
        skip_cols:
            Column names to exclude from the snapshot.  Pass FREE_TEXT and
            HIGH_CARD_CATEGORICAL columns here — their top-frequency maps are
            meaningless across runs (random pool sampling produces disjoint
            top-N sets every time) and will always produce false critical drift.
        """
        _skip = skip_cols or set()
        col_stats: Dict[str, Any] = {}

        for col in df.columns:
            if col.startswith("_"):
                continue
            if col in _skip:
                continue
            try:
                series = df[col].dropna()
                if pd.api.types.is_numeric_dtype(series):
                    vals = pd.to_numeric(series, errors="coerce").dropna()
                    if len(vals) < 2:
                        continue
                    col_stats[col] = {
                        "type": "numeric",
                        "mean": float(vals.mean()),
                        "std":  float(vals.std()),
                        "q25":  float(np.percentile(vals, 25)),
                        "q50":  float(np.percentile(vals, 50)),
                        "q75":  float(np.percentile(vals, 75)),
                        "min":  float(vals.min()),
                        "max":  float(vals.max()),
                    }
                else:
                    vc = series.astype(str).value_counts(normalize=True)
                    if len(vc) > _CATEGORICAL_CARDINALITY_CAP:
                        # Too many unique values for top-freq drift to be
                        # meaningful — decoded email addresses, IDs, etc.
                        # that slipped through classification go here.
                        continue
                    col_stats[col] = {
                        "type": "categorical",
                        "top_freqs": vc.head(20).to_dict(),
                    }
            except Exception:
                continue

        return RunSnapshot(
            run_id      = run_id,
            timestamp   = datetime.now(timezone.utc).isoformat(),
            seed        = seed,
            n_rows      = len(df),
            fingerprint = self._fingerprint,
            column_stats = col_stats,
        )

    def compare_and_record(
        self,
        snapshot: RunSnapshot,
        df:       pd.DataFrame,
    ) -> DriftReport:
        """
        Compare snapshot to the latest stored run. Append snapshot to history.
        Raises PipelineHardFail if critical drift is detected.
        """
        previous = self._load_latest()
        report   = self._compute_drift(snapshot, previous)

        self._append_history(snapshot)
        self._save_latest(snapshot)

        if report.has_critical_drift:
            raise PipelineHardFail(
                message = (
                    f"TEMPORAL DRIFT CRITICAL: {report.message}. "
                    f"Max JS divergence = {report.max_drift:.4f} "
                    f"(threshold: {_CRITICAL_DRIFT_THRESHOLD}). "
                    f"Drifted columns: {', '.join(report.drifted_columns)}."
                ),
                stage   = "drift_store",
                context = {
                    "run_id":          snapshot.run_id,
                    "previous_run_id": report.previous_run_id,
                    "column_drifts":   report.column_drifts,
                    "max_drift":       report.max_drift,
                },
            )

        return report

    # ── Internal ──────────────────────────────────────────────────

    def _compute_drift(
        self,
        current:  RunSnapshot,
        previous: Optional[RunSnapshot],
    ) -> DriftReport:
        if previous is None:
            return DriftReport(
                run_id           = current.run_id,
                previous_run_id  = None,
                column_drifts    = {},
                max_drift        = 0.0,
                avg_drift        = 0.0,
                drifted_columns  = [],
                has_warning      = False,
                has_critical_drift = False,
                message          = "No previous run to compare against.",
            )

        column_drifts:   Dict[str, float] = {}
        drifted_columns: List[str]        = []

        for col, cur_stats in current.column_stats.items():
            prev_stats = previous.column_stats.get(col)
            if prev_stats is None or cur_stats.get("type") != prev_stats.get("type"):
                continue

            try:
                if cur_stats["type"] == "numeric":
                    js = _gaussian_js(
                        prev_stats["mean"], max(prev_stats["std"], 1e-6),
                        cur_stats["mean"],  max(cur_stats["std"],  1e-6),
                    )
                else:
                    js = _categorical_js(
                        prev_stats.get("top_freqs", {}),
                        cur_stats.get("top_freqs",  {}),
                    )

                column_drifts[col] = round(js, 4)
                if js > _WARN_DRIFT_THRESHOLD:
                    drifted_columns.append(col)
            except Exception:
                continue

        max_drift  = max(column_drifts.values(), default=0.0)
        avg_drift  = float(np.mean(list(column_drifts.values()))) if column_drifts else 0.0
        has_warn   = max_drift > _WARN_DRIFT_THRESHOLD
        has_crit   = max_drift > _CRITICAL_DRIFT_THRESHOLD
        message    = (
            f"Drift vs run '{previous.run_id}': "
            f"avg={avg_drift:.4f}, max={max_drift:.4f}"
        )

        return DriftReport(
            run_id             = current.run_id,
            previous_run_id    = previous.run_id,
            column_drifts      = column_drifts,
            max_drift          = round(max_drift, 4),
            avg_drift          = round(avg_drift, 4),
            drifted_columns    = drifted_columns,
            has_warning        = has_warn,
            has_critical_drift = has_crit,
            message            = message,
        )

    def _load_latest(self) -> Optional[RunSnapshot]:
        if not os.path.exists(self._latest_path):
            return None
        try:
            with open(self._latest_path, encoding="utf-8") as f:
                d = json.load(f)
            return RunSnapshot(**d)
        except Exception:
            return None

    def _save_latest(self, snapshot: RunSnapshot) -> None:
        d   = asdict(snapshot)
        dir_path = self._dir
        fd, tmp  = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(d, f, ensure_ascii=False)
            os.replace(tmp, self._latest_path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    def _append_history(self, snapshot: RunSnapshot) -> None:
        d = asdict(snapshot)
        try:
            # Trim to rolling window
            lines: List[str] = []
            if os.path.exists(self._hist_path):
                with open(self._hist_path, encoding="utf-8") as f:
                    lines = f.readlines()
            lines = lines[-(_MAX_HISTORY_ENTRIES - 1):]
            lines.append(json.dumps(d, ensure_ascii=False) + "\n")
            dir_path = self._dir
            fd, tmp  = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.writelines(lines)
            os.replace(tmp, self._hist_path)
        except Exception:
            pass


# ==================================================================
# Math helpers
# ==================================================================

def _kl(p: np.ndarray, q: np.ndarray) -> float:
    mask = p > 0
    return float(np.sum(p[mask] * np.log(p[mask] / q[mask])))


def _gaussian_js(mu1: float, s1: float, mu2: float, s2: float, n: int = 500) -> float:
    rng = np.random.default_rng(42)
    a   = rng.normal(mu1, s1, n)
    b   = rng.normal(mu2, s2, n)
    lo, hi = min(a.min(), b.min()), max(a.max(), b.max())
    if lo == hi:
        return 0.0
    edges = np.linspace(lo, hi, 21)
    p, _ = np.histogram(a, bins=edges, density=True)
    q, _ = np.histogram(b, bins=edges, density=True)
    p    = p.astype(float) + 1e-10
    q    = q.astype(float) + 1e-10
    p   /= p.sum();  q /= q.sum()
    m    = 0.5 * (p + q)
    return min(1.0, max(0.0, 0.5 * _kl(p, m) + 0.5 * _kl(q, m)))


def _categorical_js(prev: Dict[str, float], cur: Dict[str, float]) -> float:
    cats = sorted(set(prev) | set(cur))
    if not cats:
        return 0.0
    p = np.array([prev.get(c, 0.0) for c in cats]) + 1e-10
    q = np.array([cur.get(c,  0.0) for c in cats]) + 1e-10
    p /= p.sum();  q /= q.sum()
    m  = 0.5 * (p + q)
    return min(1.0, max(0.0, 0.5 * _kl(p, m) + 0.5 * _kl(q, m)))
