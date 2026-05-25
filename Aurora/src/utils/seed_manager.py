"""
seed_manager.py — Global Determinism Manager
=============================================

Ensures every random operation in the pipeline is seeded from a single
root and that the seed is recorded in the run audit.

Design
------
    1. generate() calls seed_manager.init(seed) at the very top.
    2. seed_manager.init() returns a root np.random.Generator.
    3. All engines derive per-engine RNGs from the root via spawn().
    4. Seed is logged via audit_logger.
    5. If seed is None, a random seed is generated and still logged
       (so runs are reproducible from the log).

API
---
    init(seed=None)  → root_rng, resolved_seed
    spawn(root_rng, name)  → child_rng (deterministic from root + name)
    current_seed()   → int | None  (the seed used in the current run)
"""

from __future__ import annotations

import hashlib
import os
import struct
from typing import Optional, Tuple

import numpy as np


# Module-level state (one active run at a time per process)
_current_seed: Optional[int] = None
_root_rng:     Optional[np.random.Generator] = None


def init(seed: Optional[int] = None) -> Tuple[np.random.Generator, int]:
    """
    Initialise determinism for a new run.

    Parameters
    ----------
    seed : int seed to use, or None to auto-generate one and record it.

    Returns
    -------
    (root_rng, resolved_seed)
        root_rng     — seeded Generator for the caller
        resolved_seed — the seed that was actually used (log this!)
    """
    global _current_seed, _root_rng

    if seed is None:
        # Generate a reproducible seed from OS entropy,
        # but record it so the run is reproducible from the audit log.
        seed = int.from_bytes(os.urandom(8), "big") & 0x7FFFFFFFFFFFFFFF

    _current_seed = seed
    _root_rng     = np.random.default_rng(seed)
    return _root_rng, seed


def spawn(root_rng: np.random.Generator, name: str) -> np.random.Generator:
    """
    Derive a deterministic child Generator from root_rng and a name.

    Different names yield independent but deterministic child streams.
    Avoids sharing the root RNG between engine threads/stages.

    Usage:
        stat_rng = seed_manager.spawn(root_rng, "statistical_engine")
        val_rng  = seed_manager.spawn(root_rng, "validation_layer")
    """
    # Hash name to a 64-bit integer seed offset
    name_hash = hashlib.sha256(name.encode()).digest()[:8]
    name_int  = struct.unpack(">Q", name_hash)[0] & 0x7FFFFFFFFFFFFFFF

    # Combine with a draw from the root to make the child depend on root state
    root_draw = int(root_rng.integers(low=0, high=2**62))
    child_seed = (name_int ^ root_draw) & 0x7FFFFFFFFFFFFFFF
    return np.random.default_rng(child_seed)


def current_seed() -> Optional[int]:
    """Return the seed used in the current run, or None if not initialised."""
    return _current_seed


def reset() -> None:
    """Reset module state (for testing)."""
    global _current_seed, _root_rng
    _current_seed = None
    _root_rng     = None
