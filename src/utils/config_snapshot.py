"""
config_snapshot.py — Immutable Run Configuration
=================================================

Captures the full configuration for one pipeline run at the moment
generate() is called, hashes it, and freezes it.

Purpose
-------
- Prevent config mutation mid-run (concurrency + state-sharing bugs)
- Provide a reproducible snapshot for debugging and audit
- Enable strict equality comparison between runs

Usage
-----
    snap = config_snapshot.create(
        dataset_path  = "/data/train.csv",
        baseline_path = "/cache/baseline.json",
        n             = 500,
        seed          = 42,
        engine        = "statistical",
        cache_dir     = "/cache",
    )
    # snap is frozen — any attribute set after creation raises FrozenError

    # Compare two runs:
    assert snap1.config_hash == snap2.config_hash  # same config

    # Serialise to dict (for CheckPoint header):
    snap.to_dict()
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional


class FrozenError(Exception):
    """Raised when a frozen ConfigSnapshot is mutated."""


@dataclass(frozen=True)
class ConfigSnapshot:
    """
    Immutable configuration for one generate() run.

    All fields are set at creation time and cannot be modified.
    `config_hash` is a SHA-256 digest of the configuration (excluding
    run_id and created_at which vary per run even for identical configs).
    """
    run_id:        str
    created_at:    str
    dataset_path:  str
    baseline_path: str
    n:             int
    seed:          Optional[int]
    engine:        str
    cache_dir:     Optional[str]
    config_hash:   str          # SHA-256 of the stable config fields

    def to_dict(self) -> Dict[str, Any]:
        """Serialise to a plain dict (JSON-safe)."""
        return {
            "run_id":        self.run_id,
            "created_at":    self.created_at,
            "dataset_path":  self.dataset_path,
            "baseline_path": self.baseline_path,
            "n":             self.n,
            "seed":          self.seed,
            "engine":        self.engine,
            "cache_dir":     self.cache_dir,
            "config_hash":   self.config_hash,
        }

    def matches(self, other: "ConfigSnapshot") -> bool:
        """
        Return True if two snapshots represent identical pipeline configs.
        (run_id and created_at are excluded from the comparison.)
        """
        return self.config_hash == other.config_hash


def create(
    run_id:        str,
    dataset_path:  str,
    baseline_path: str,
    n:             int,
    seed:          Optional[int],
    engine:        str,
    cache_dir:     Optional[str] = None,
) -> ConfigSnapshot:
    """
    Create a frozen, hashed ConfigSnapshot for a pipeline run.

    Parameters
    ----------
    run_id        : unique run identifier (UUID or fingerprint+timestamp)
    dataset_path  : absolute path to the original dataset file
    baseline_path : absolute path to the BaselineArtifact JSON
    n             : requested row count
    seed          : random seed (may be None — seed_manager resolves it)
    engine        : engine name ("statistical" | "probabilistic" | "ctgan")
    cache_dir     : optional cache directory path

    Returns
    -------
    Frozen ConfigSnapshot.
    """
    # Only hash stable fields (not run_id, created_at, or resolved_seed)
    stable = {
        "dataset_path":  dataset_path,
        "baseline_path": baseline_path,
        "n":             n,
        "seed":          seed,
        "engine":        engine,
        "cache_dir":     cache_dir or "",
    }
    config_hash = _hash_dict(stable)

    return ConfigSnapshot(
        run_id        = run_id,
        created_at    = _now_iso(),
        dataset_path  = dataset_path,
        baseline_path = baseline_path,
        n             = n,
        seed          = seed,
        engine        = engine,
        cache_dir     = cache_dir,
        config_hash   = config_hash,
    )


def _hash_dict(d: Dict[str, Any]) -> str:
    """Return a stable SHA-256 hex digest of a JSON-serialised dict."""
    canonical = json.dumps(d, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
