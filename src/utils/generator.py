"""
generator.py — Synthetic Data Generation Engine
================================================

Sits at stage 3 of the pipeline:

    parse.py → baseline.py → generator.py → leakage_agent.py

Reads the BaselineArtifact produced by baseline.py and generates
synthetic structured data that preserves the statistical properties
of the original dataset.

Invocation (from extension.ts via cp.spawn)
-------------------------------------------
    python generator.py <dataset_path> <baseline_json_path>
                        --n <count>
                        --cache-dir <dir>

Output (stdout, JSON)
---------------------
    {
        "samples":            [...],        # list of row dicts
        "generator_used":     "statistical|probabilistic|ctgan",
        "row_count":          500,
        "dataset_fingerprint": "abc123...",
        "warnings":           []
    }

Engine selection by dataset size
---------------------------------
    rows <  1 000                → StatisticalEngine
    1 000 <= rows < 50 000       → ProbabilisticEngine  (Gaussian copula)
    rows >= 50 000               → CTGANEngine           (falls back to
                                                          Probabilistic if
                                                          ctgan not installed)

Model caching
-------------
    Trained models are serialised to:
        <cache_dir>/<fingerprint>_<engine>.pkl
    On cache hit the model is loaded and .sample(n) is called directly,
    skipping retraining entirely.

Dependencies
------------
    Required : pandas, numpy          (already present via baseline.py)
    Optional : ctgan                  (only needed for CTGANEngine;
                                       graceful fallback if missing)
"""

from __future__ import annotations

import argparse
import json
import math
import os
import pickle   # kept for CTGAN model type compat — I/O is via signed_pickle_loader
from signed_pickle_loader import safe_dump, safe_load, SecurityError

import sys
import warnings as _warnings_mod
from typing import Any, Dict, List, Optional, Tuple

import hashlib
import re
import numpy as np
import pandas as pd

# Module-level compiled regex — Fix 14 (compile once) + Fix 16 (full numeric pattern)
_NUMERIC_STR = re.compile(r'^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$')

# ctgan is optional — we detect it at import time and degrade gracefully
try:
    from ctgan import CTGANSynthesizer  # type: ignore
    _CTGAN_AVAILABLE = True
except Exception:
    _CTGAN_AVAILABLE = False

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Validation layer — ConstraintFilter, RowQualityFilter, DuplicatePreFilter
# are all owned by validation.py.  generator.py uses the unified interface.
from validation import ValidationLayer, ValidationResult  # noqa: E402

# CheckPoint — atomic per-run row store and agent polling interface.
from checkp import CheckPoint  # noqa: E402

# ── Enforcement layer (Phase-2 hardening) ────────────────────────────────────
from pipeline_errors    import PipelineHardFail, StageError    # noqa: E402
import enforcement_engine  as _enforce_mod                      # noqa: E402
import seed_manager        as _seed_mgr                         # noqa: E402
import config_snapshot     as _cfg_snap                         # noqa: E402
import audit_logger        as _audit_mod                        # noqa: E402
from leakage_gate          import enforce_leakage               # noqa: E402
from output_controller     import OutputController, export_guarded  # noqa: E402
from evaluation_pipeline   import evaluate as _eval_fn          # noqa: E402
from execution_controller  import pipeline_slot                 # noqa: E402
from diversity_guard       import check_diversity, tag_generated_rows  # noqa: E402
from drift_store           import DriftStore                    # noqa: E402
from preprocessing_layer   import (                              # noqa: E402
    build_manifest, apply_manifest, merge_outputs,
    PreprocessingManifest, ColumnMergeError,
)
from constraint_enforcer   import (                              # noqa: E402
    load_constraint_rules, enforce_constraints,
)

# ------------------------------------------------------------------
# Constants
# ------------------------------------------------------------------

_SMALL_THRESHOLD    = 1_000    # rows below this → StatisticalEngine
_LARGE_THRESHOLD    = 50_000   # rows at/above   → CTGANEngine
_MAX_RESAMPLE       = 3        # constraint re-sample attempts before clamp
_MAX_QUALITY_ROUNDS = 8        # hard cap on ValidationLayer retry rounds


# ==================================================================
# Policy loader — reads synthetic_data section from policy.yaml
# so generator.py respects excluded_columns, column_type_overrides,
# default_seed, and default_n without requiring CLI changes.
# ==================================================================

def _load_synthetic_policy(dataset_path: str) -> Dict[str, Any]:
    """
    Search for policy.yaml in the dataset's directory and its parents
    (up to 3 levels).  Returns the ``synthetic_data`` sub-dict, or {}
    if no policy file is found or the section is absent.
    """
    search_dirs = []
    d = os.path.dirname(os.path.abspath(dataset_path))
    for _ in range(4):
        search_dirs.append(d)
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent

    for search_dir in search_dirs:
        candidate = os.path.join(search_dir, "policy.yaml")
        if not os.path.exists(candidate):
            continue
        try:
            with open(candidate, "r", encoding="utf-8") as fh:
                raw = fh.read()
            # Minimal YAML parser: find the synthetic_data section and
            # parse its immediate children.  Avoids a PyYAML dependency.
            section: Dict[str, Any] = {}
            in_section = False
            for line in raw.splitlines():
                stripped = line.rstrip()
                if stripped.startswith("synthetic_data:"):
                    in_section = True
                    continue
                if in_section:
                    # End of section: non-empty line with no leading spaces
                    if stripped and not stripped.startswith(" ") and not stripped.startswith("#"):
                        break
                    # Skip comments and blanks
                    if not stripped or stripped.lstrip().startswith("#"):
                        continue
                    # 2-space key: value
                    m = re.match(r"^  ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)?$", stripped)
                    if m:
                        key, val = m.group(1), m.group(2).strip()
                        if val:
                            # Scalar value
                            try:
                                section[key] = int(val)
                            except ValueError:
                                try:
                                    section[key] = float(val)
                                except ValueError:
                                    section[key] = val
                        else:
                            section[key] = []  # list or sub-dict follows
                        continue
                    # 4-space list item under a key
                    m2 = re.match(r"^    -\s+(.+)$", stripped)
                    if m2 and section:
                        last_key = list(section.keys())[-1]
                        if isinstance(section[last_key], list):
                            section[last_key].append(m2.group(1).strip())
                        continue
                    # 4-space key: value (sub-dict)
                    m3 = re.match(r"^    ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)?$", stripped)
                    if m3 and section:
                        last_key = list(section.keys())[-1]
                        if not isinstance(section[last_key], dict):
                            section[last_key] = {}
                        sub_val = m3.group(2).strip()
                        section[last_key][m3.group(1)] = sub_val
                        continue
            return section
        except Exception:
            pass  # malformed policy — fall through

    return {}


# ==================================================================
# Shared statistical helpers
#
# Consolidated here because two or more fixes in the improvement
# roadmap independently called for the same statistical pattern
# (adaptive bin count from cardinality; empirical-Bayes shrinkage of
# a frequency table toward a reference distribution). Rather than
# implement each occurrence as its own inline copy, both call sites
# share one implementation so there is exactly one place that
# encodes each statistical rule.
# ==================================================================

def _adaptive_bin_count(
    n_valid: int,
    cardinality: int,
    min_per_cell: int = 5,
    lo: int = 3,
    hi: int = 10,
) -> int:
    """
    Adaptive bin/stratum count so each (bin, category) contingency
    cell has roughly `min_per_cell` expected observations (Scott,
    1979 bin-count heuristic). Used by:
      - FIX-04: conditional categorical bin count in _build_cat_tables
      - FIX-15: regression target bin count in build_class_stats
    """
    return max(lo, min(hi, int(n_valid / max(1, cardinality * min_per_cell))))


def _shrink_freq_table(
    obs_freq: Dict[str, float],
    ref_freq: Dict[str, float],
    n_obs: int,
    k_scale: float = 2.0,
) -> Dict[str, float]:
    """
    Empirical-Bayes shrinkage of an observed frequency table toward a
    reference (e.g. global/unconditional) frequency table, with the
    shrinkage strength scaling with the number of distinct categories
    (Good, 1965; Agresti, 2013). Used by:
      - FIX-02: per-stratum categorical frequencies (build_class_stats)
      - FIX-14: per-bin conditional frequencies (_build_cat_tables,
        single-partner case)
      - FIX-07: per-joint-bin conditional frequencies (_build_cat_tables,
        multi-partner case)

    `k_scale` controls the pseudo-count multiplier per category
    (k_shrink = max(1, n_cats / 5) * k_scale); callers use different
    k_scale values to match their originally-approved formulas
    (10 for per-bin conditional tables, 2 for per-stratum tables).
    """
    all_cats = set(obs_freq) | set(ref_freq)
    if not all_cats:
        return {}
    k_shrink = max(1, len(all_cats) / 5) * k_scale
    alpha = n_obs / (n_obs + k_shrink)
    smoothed = {
        cat: alpha * obs_freq.get(cat, 0.0) + (1 - alpha) * ref_freq.get(cat, 0.0)
        for cat in all_cats
    }
    total = sum(smoothed.values())
    if total > 0:
        smoothed = {c: v / total for c, v in smoothed.items()}
    return smoothed


def _apply_null_masks(
    bl: "BaselineReader",  # type: ignore[name-defined]
    data: Dict[str, np.ndarray],
    n: int,
    rng: np.random.Generator,
) -> Dict[str, np.ndarray]:
    """
    Inject nulls into `data` in place (and return it), used identically by
    StatisticalEngine.sample() and ProbabilisticEngine.sample() -- this
    used to be two independent copies of the same loop.

    FIX-08: columns covered by bl.null_corr (populated by
    build_class_stats(); see there) get correlated nulls via a Gaussian
    copula instead of independent per-column Bernoulli draws, so e.g.
    Income and TaxBracket go missing together at roughly the rate seen in
    the original data. Every other null-bearing column (or all of them,
    when null_corr is unavailable -- old caches, <2 null columns, or a
    zero-variance null indicator) falls back to the original independent
    injection. Null RATES are preserved exactly either way; only the
    joint missingness PATTERN changes.
    """
    correlated_cols = set(bl.null_cols) if bl.null_corr is not None else set()

    if correlated_cols:
        from scipy.special import ndtri  # type: ignore  # local import, matches existing style

        cov = bl.null_corr
        z = rng.multivariate_normal(np.zeros(len(bl.null_cols)), cov, size=n)
        for i, col in enumerate(bl.null_cols):
            if col not in data:
                continue
            nr = bl.null_ratio(col)
            if nr <= 0.0:
                continue
            # Clip away from 0/1 so ndtri never sees ±inf for a
            # near-certain or near-impossible null rate.
            threshold = ndtri(min(max(nr, 1e-9), 1 - 1e-9))
            null_mask = z[:, i] < threshold
            arr = data[col].astype(object)
            arr[null_mask] = None
            data[col] = arr

    for col in bl.col_order:
        if col in correlated_cols:
            continue  # already handled above via the copula
        nr = bl.null_ratio(col)
        if nr > 0.0 and col in data:
            null_mask = rng.random(n) < nr
            arr = data[col].astype(object)
            arr[null_mask] = None
            data[col] = arr

    return data


# ==================================================================
# Section 1 — BaselineReader
# Read and normalise the BaselineArtifact JSON into plain dicts
# so every engine works with simple Python types, not nested
# dataclass shapes.
# ==================================================================

class BaselineReader:
    """
    Adapts the BaselineArtifact JSON (produced by baseline.py) into
    flat, engine-friendly structures.

    Attributes
    ----------
    fingerprint : str
    row_count   : int
    col_order   : list[str]   ordered column names from the baseline
    numeric     : dict        col → NumericColumnBaseline fields as dict
    categorical : dict        col → CategoricalColumnBaseline fields as dict
    other       : dict        col → {"dtype": ..., "null_ratio": ...}
    pearson     : dict        "a__b" → float
    cramers_v   : dict        "a__b" → float   (cat↔cat)
    pb          : dict        "cat__num" → float (cat↔num)
    num_ranges  : dict        col → (min, max)
    allowed     : dict        col → [str, ...]
    """

    # Empirical-Bayes shrinkage strength for per-stratum categorical
    # frequency tables in build_class_stats(). A stratum needs roughly this
    # many rows for a given column before its own observed distribution
    # gets equal weight with the column's global distribution; below that,
    # the blend leans increasingly toward the global table to avoid
    # overfitting to a handful of noisy per-stratum observations.
    CAT_SHRINKAGE_K = 20
    # Fix E: lighter shrinkage for regression strata.  With K=20 a sparse
    # (stratum, EX) cell with 10 rows gets alpha=10/30≈0.33 (mostly global),
    # causing EX to be under-sampled in upper salary strata.  K=8 gives
    # alpha=10/18≈0.56 (mostly observed) — enough to let the true per-stratum
    # EX frequency show through.
    CAT_SHRINKAGE_K_REGRESSION = 8

    @staticmethod
    def _norm_lv(v) -> str:
        """Canonical string form for any stratum/label value used as a
        dict key. Handles numpy ints, numpy str_, plain int, plain str —
        all collapse to the same plain Python str so dict lookups never
        silently miss due to type mismatch."""
        return str(v)

    def __init__(self, artifact: Dict[str, Any]) -> None:
        meta        = artifact.get("meta",         {})
        columns     = artifact.get("columns",      {})
        correlations = artifact.get("correlations", {})
        constraints = artifact.get("constraints",  {})

        self.fingerprint : str       = meta.get("dataset_fingerprint", "")
        self.row_count   : int       = int(meta.get("row_count") or 0)
        self.source      : str       = meta.get("dataset_source", "")

        self.numeric     : Dict[str, Dict[str, Any]] = columns.get("numeric",     {})
        self.categorical : Dict[str, Dict[str, Any]] = columns.get("categorical", {})
        self.other       : Dict[str, Dict[str, Any]] = columns.get("other",       {})

        # Column order: use stored original order from baseline metadata when available.
        # Falls back to numeric→categorical→other grouping for older baselines.
        stored_order: List[str] = meta.get("col_order") or []
        if stored_order:
            self.col_order = stored_order
        else:
            self.col_order = (
                list(self.numeric.keys()) +
                list(self.categorical.keys()) +
                list(self.other.keys())
            )

        # Correlations
        self.pearson   : Dict[str, float] = correlations.get("numeric_pearson",       {})
        self.cramers_v : Dict[str, float] = correlations.get("categorical_cramers_v", {})
        self.pb        : Dict[str, float] = correlations.get("categorical_numeric_pb", {})

        # Constraints
        raw_ranges = constraints.get("numeric_ranges", {})
        self.num_ranges: Dict[str, Tuple[Optional[float], Optional[float]]] = {}
        for col, rng in raw_ranges.items():
            # stored as list [min, max] after JSON round-trip
            if isinstance(rng, (list, tuple)) and len(rng) == 2:
                lo = float(rng[0]) if rng[0] is not None else None
                hi = float(rng[1]) if rng[1] is not None else None
                self.num_ranges[col] = (lo, hi)

        self.allowed: Dict[str, List[str]] = constraints.get("allowed_values", {})

        # ------------------------------------------------------------------
        # Target column detection (dataset-agnostic heuristic)
        # A categorical column is treated as the label/target when it is
        # low-cardinality (2–50 classes) AND has the highest total absolute
        # point-biserial association with numeric columns.  This matches the
        # typical "target column correlates with many features" pattern without
        # relying on any domain-specific column name.
        # Falls back to a regression target when no classification label is found
        # and the dataset is large enough (>= 150 rows).
        # ------------------------------------------------------------------
        self.target_type: Optional[str] = None
        self.regression_bin_edges: Optional[np.ndarray] = None
        self.label_col: Optional[str]
        self.label_col, self.target_type = self._detect_target_col()

        # Per-class statistics populated lazily by build_class_stats().
        # Structure: col → label_value → {"mean": float, "std": float,
        #                                  "min": float, "max": float,
        #                                  "q25": float, "q75": float}
        self.class_numeric_stats: Dict[str, Dict[str, Dict[str, float]]] = {}
        # Structure: cat_col → label_value → {value: prob}
        self.class_cat_stats: Dict[str, Dict[str, Dict[str, float]]] = {}
        # Marginal label distribution {label_value: probability}
        # Only populated for classification targets (label_col in categorical).
        self.label_dist: Dict[str, float] = {}
        if self.label_col and self.label_col in self.categorical:
            ratios = self.categorical[self.label_col].get("top_value_ratios") or {}
            total  = sum(ratios.values()) or 1.0
            self.label_dist = {k: v / total for k, v in ratios.items()}
        # Per-class covariance matrices populated by build_class_stats()
        # col_group → label_value → (mean_vec, cov_matrix, col_names)
        self.class_covariance: Dict[str, Tuple[np.ndarray, np.ndarray, List[str]]] = {}

        # FIX-08: cross-column null-correlation matrix, also populated by
        # build_class_stats() (see there for why it lives in the same
        # method despite not being class-conditional). None until
        # build_class_stats() runs; null_cols gives the column order
        # matching null_corr's rows/columns.
        self.null_corr: Optional[np.ndarray] = None
        self.null_cols: List[str] = []

        # Fix 3: regression-aware conditional target draw
        # The single categorical column most strongly correlated with the
        # regression target (via between-category variance ratio).  None when
        # no column clears the 0.05 threshold or when target_type != regression.
        self.primary_target_cat_col: Optional[str] = None
        # Per-(stratum, category) quantile profiles for the chosen column.
        # Keys are (str(label_value), str(category_value)); values are dicts
        # with keys min/max/q01/q05/q25/q50/q75/q95/q99 — same shape as
        # _build_quantile_cdf() expects.
        self.target_cat_quantiles: Dict[Tuple[str, str], Dict[str, float]] = {}

    # ------------------------------------------------------------------
    # Convenience helpers
    # ------------------------------------------------------------------

    def is_numeric(self, col: str) -> bool:
        return col in self.numeric

    def is_categorical(self, col: str) -> bool:
        return col in self.categorical

    def null_ratio(self, col: str) -> float:
        if col in self.numeric:
            return float(self.numeric[col].get("null_ratio", 0.0))
        if col in self.categorical:
            return float(self.categorical[col].get("null_ratio", 0.0))
        if col in self.other:
            return float(self.other[col].get("null_ratio", 0.0))
        return 0.0

    def strong_pearson_pairs(self, threshold: float = 0.4) -> List[Tuple[str, str, float]]:
        """Return (col_a, col_b, corr) for pairs above threshold."""
        pairs = []
        for key, v in self.pearson.items():
            if abs(v) >= threshold:
                a, b = key.split("__", 1)
                pairs.append((a, b, v))
        return pairs

    def strong_pb_pairs(self, threshold: float = 0.3) -> List[Tuple[str, str, float]]:
        """Return (cat_col, num_col, r) for point-biserial pairs above threshold."""
        pairs = []
        for key, v in self.pb.items():
            if abs(v) >= threshold:
                cat, num = key.split("__", 1)
                pairs.append((cat, num, v))
        return pairs

    # ------------------------------------------------------------------
    # Label-column detection
    # ------------------------------------------------------------------

    def _detect_target_col(self) -> Tuple[Optional[str], Optional[str]]:
        """
        Heuristically identify a target column from the baseline.

        Returns a tuple (col_name, target_type) where target_type is one of
        "classification", "regression", or None (when no target is found).

        Classification criteria (all must pass):
        1. Column is categorical with 2–50 unique values.
        2. Column appears in at least one point-biserial entry as the
           cat side (i.e. it correlates with at least one numeric feature).
        3. Among all qualifying columns, the one with the highest *sum* of
           absolute point-biserial correlations across all numeric partners
           is selected.  This mirrors the intuition that a target variable
           tends to correlate broadly with features.

        Regression fallback (when no classification target found):
        - Requires self.row_count >= 150.
        - Scores each numeric column by:
              Pearson correlations  × 0.5
              Point-biserial (pb)   × 1.5  (numeric side, after __ in key)
        - Selects the highest-scoring numeric column if score >= 2.0.

        Returns (None, None) if no suitable column is found.
        """
        _MIN_CLASSES = 2
        _MAX_CLASSES = 50

        # ── Classification path ────────────────────────────────────────

        # Collect qualifying categorical columns
        qualifying: List[str] = []
        for col, spec in self.categorical.items():
            uc = spec.get("unique_count")
            if uc is None:
                continue
            if _MIN_CLASSES <= int(uc) <= _MAX_CLASSES:
                # Reject high-cardinality ID/name columns where unique_count / row_count is too high
                if self.row_count > 0 and (int(uc) / self.row_count) > 0.3:
                    continue
                qualifying.append(col)

        if qualifying:
            # Reject columns whose top_value_ratios keys are all numeric-like strings
            filtered: List[str] = []
            for col in qualifying:
                spec   = self.categorical[col]
                ratios = spec.get("top_value_ratios") or {}
                vals   = list(ratios.keys())
                if vals and all(_NUMERIC_STR.match(str(v)) for v in vals):
                    try:
                        numeric_vals = sorted([float(v) for v in vals])
                        if len(numeric_vals) > 10:
                            span = numeric_vals[-1] - numeric_vals[0]
                            if span > len(numeric_vals) * 2:
                                continue
                    except (ValueError, TypeError):
                        pass
                filtered.append(col)
            qualifying = filtered

        if qualifying:
            # Score each qualifying column by total abs point-biserial
            scores: Dict[str, float] = {col: 0.0 for col in qualifying}
            for key, v in self.pb.items():
                cat_col = key.split("__", 1)[0]
                if cat_col in scores:
                    scores[cat_col] += abs(v)

            # Must have at least one numeric correlation to qualify
            candidates = {col: s for col, s in scores.items() if s > 0.0}
            if candidates:
                return (max(candidates, key=lambda c: candidates[c]), "classification")

        # ── Regression fallback ────────────────────────────────────────
        # Only attempted when no classification target was found and the
        # dataset is large enough for quantile binning to be meaningful.
        if self.row_count < 150:
            return (None, None)

        reg_scores: Dict[str, float] = {col: 0.0 for col in self.numeric}

        # Pearson contribution (numeric ↔ numeric)
        for key, v in self.pearson.items():
            parts = key.split("__", 1)
            if len(parts) == 2:
                col_a, col_b = parts
                if col_a in reg_scores:
                    reg_scores[col_a] += abs(v) * 0.5
                if col_b in reg_scores:
                    reg_scores[col_b] += abs(v) * 0.5

        # Point-biserial contribution (numeric side is after __)
        for key, v in self.pb.items():
            parts = key.split("__", 1)
            if len(parts) == 2:
                num_col = parts[1]
                if num_col in reg_scores:
                    reg_scores[num_col] += abs(v) * 1.5

        if not reg_scores:
            return (None, None)

        best_col   = max(reg_scores, key=lambda c: reg_scores[c])
        best_score = reg_scores[best_col]

        if best_score >= 2.0:
            return (best_col, "regression")

        return (None, None)

    # ------------------------------------------------------------------
    # Per-class statistics builder (called by engines that have the df)
    # ------------------------------------------------------------------

    def build_class_stats(self, df: "pd.DataFrame") -> None:  # type: ignore[name-defined]
        """
        Compute per-class (per-label) statistics for all numeric and
        categorical columns.  Populates:
            self.class_numeric_stats
            self.class_cat_stats
            self.class_covariance

        Also computes (FIX-08), regardless of label_col: the cross-column
        null-correlation matrix used by correlated null injection at
        sample time. This lives here rather than in a new orchestration
        stage because build_class_stats() is already the one existing
        fitting pass that (a) is called unconditionally by
        ProbabilisticEngine.fit() and (b) receives the raw df needed to
        measure null co-occurrence — reusing it avoids a second df-walk
        and a second cache object for what is fundamentally the same
        "derive dataset-level statistics from df" step.
        Populates:
            self.null_corr
            self.null_cols

        Safe to call multiple times; results are overwritten.
        Requires pandas to be imported (guaranteed by the engine that calls it).
        """
        import pandas as _pd  # local import to avoid top-level hard dep

        # FIX-08: null correlation is a whole-dataset property (unlike the
        # class-conditional stats below), so it must not be skipped when
        # there's no label column -- computed before the label_col guard.
        null_cols = [c for c in self.col_order if self.null_ratio(c) > 0.01 and c in df.columns]
        if len(null_cols) >= 2:
            null_indicators = df[null_cols].isna().astype(float)
            corr = null_indicators.corr().values
            if not np.any(np.isnan(corr)):
                self.null_corr = _nearest_pd(corr)
                self.null_cols = null_cols
            else:
                # A column with zero variance in its null indicator (e.g.
                # null_ratio computed from stale baseline stats but no
                # actual nulls in this df) produces NaN correlations;
                # fall back to independent injection rather than risk a
                # singular/garbage copula.
                self.null_corr = None
                self.null_cols = []
        else:
            self.null_corr = None
            self.null_cols = []

        if not self.label_col or self.label_col not in df.columns:
            return

        # ── Regression branch ──────────────────────────────────────────
        # For regression targets, quantile-bin the continuous target into
        # n_bins strata so that downstream label-conditioned sampling can
        # still use the per-class statistics machinery.  Bin edges are
        # stored in self.regression_bin_edges for later inverse-mapping.
        if self.target_type == "regression":
            target_series = pd.to_numeric(df[self.label_col], errors="coerce")
            # FIX-15: the minimum rows-per-bin threshold (was a fixed 30)
            # now scales with the widest categorical column's cardinality,
            # so each (regression bin x category) contingency cell still
            # gets ~5 expected observations on average -- a fixed 30-row
            # floor was fine for low-cardinality categoricals but marginal
            # once a column has 10+ categories.
            max_cardinality = max(
                (len(spec.get("all_value_ratios") or spec.get("top_value_ratios") or {})
                 for spec in self.categorical.values()),
                default=1,
            )
            min_per_bin = max(30, max_cardinality * 5)
            n_bins = min(10, max(3, len(df) // 100))
            while n_bins > 3:
                trial = pd.qcut(target_series, q=n_bins, labels=False, duplicates="drop")
                if trial.value_counts().min() >= min_per_bin:
                    break
                n_bins -= 1
            bins, edges = pd.qcut(target_series, q=n_bins, labels=False, retbins=True, duplicates="drop")
            self.regression_bin_edges = edges
            label_series = bins.astype(str)
            n_actual = len(edges) - 1
            # Fix A: use actual bin frequencies instead of uniform prior.
            # pd.qcut produces equal-count bins normally, but when
            # duplicates="drop" merges bins the merged bin should carry its
            # true combined weight.  More importantly, this preserves any
            # residual skew in the real distribution so synthetic strata
            # proportions match reality rather than forcing each stratum to
            # exactly 1/n_actual.
            bin_counts = bins.value_counts(normalize=True).sort_index()
            self.label_dist = {str(int(k)): float(v) for k, v in bin_counts.items()}
        else:
            label_series = df[self.label_col].astype(str)
        label_values = label_series.unique().tolist()

        num_cols = [c for c in self.numeric
                    if c in df.columns and c != self.label_col]
        cat_cols = [c for c in self.categorical
                    if c in df.columns and c != self.label_col]

        # Global frequency table per categorical column, computed once
        # (outside the per-stratum loop) so each stratum's frequency table
        # can be shrunk toward it — see categorical block below.
        global_cat_freq: Dict[str, Dict[str, float]] = {}
        for col in cat_cols:
            s_all = df[col].dropna().astype(str)
            if len(s_all) > 0:
                global_cat_freq[col] = s_all.value_counts(normalize=True).to_dict()

        for lv in label_values:
            mask   = label_series == lv
            sub    = df[mask]
            n_sub  = int(mask.sum())
            if n_sub == 0:
                continue

            # Numeric per-class stats — full quantile profile so quantile-CDF
            # sampling can be used for each class slice (same keys as the global
            # NumericColumnBaseline spec so _sample_numeric_col works directly).
            for col in num_cols:
                s = _pd.to_numeric(sub[col], errors="coerce").dropna()
                if len(s) < 2:
                    continue
                std_val = float(s.std())
                entry = self.class_numeric_stats.setdefault(col, {})
                entry[self._norm_lv(lv)] = {
                    "mean": float(s.mean()),
                    "std":  std_val if std_val > 0 else 1e-6,
                    "min":  float(s.min()),
                    "max":  float(s.max()),
                    "q01":  float(s.quantile(0.01)),
                    "q05":  float(s.quantile(0.05)),
                    "q25":  float(s.quantile(0.25)),
                    "q50":  float(s.quantile(0.50)),
                    "q75":  float(s.quantile(0.75)),
                    "q95":  float(s.quantile(0.95)),
                    "q99":  float(s.quantile(0.99)),
                }

            # Categorical per-class stats — empirical-Bayes shrinkage toward
            # the column's global frequency table, weighted by how many rows
            # the stratum actually has for that column. Without this, sparse
            # strata (common with many label/regression bins) produce
            # frequency tables dominated by 1-2 categories seen by chance,
            # which collapses categorical diversity in generated output.
            for col in cat_cols:
                s = sub[col].dropna().astype(str)
                n_sub_col = len(s)
                if n_sub_col == 0:
                    continue
                vc = s.value_counts(normalize=True).to_dict()
                global_freq = global_cat_freq.get(col, {})

                # FIX-02: scale the shrinkage constant by the number of
                # categories in this column instead of using a single
                # global K for every column. A 50-category column needs
                # much heavier shrinkage than a 3-category column at the
                # same stratum sample size, since effective samples per
                # category (n/k) is what actually governs estimator noise
                # (Good, 1965; Agresti, 2013).
                #
                # Uses the shared _shrink_freq_table helper (see module-
                # level docstring) so this formula and FIX-14's per-bin
                # shrinkage share one implementation. The original formula
                # was k = k_base * max(1, n_cats/5), which is exactly
                # _shrink_freq_table's k_shrink with k_scale = k_base.
                k_base = (self.CAT_SHRINKAGE_K_REGRESSION
                          if self.target_type == "regression"
                          else self.CAT_SHRINKAGE_K)
                smoothed = _shrink_freq_table(vc, global_freq, n_sub_col, k_scale=k_base)

                entry = self.class_cat_stats.setdefault(col, {})
                entry[self._norm_lv(lv)] = smoothed

        # ── Fix 3: identify primary target-correlated categorical column ────
        # (regression targets only; must run after label_series/label_values
        # and num_cols/cat_cols are defined above)
        MIN_SUBGROUP_N = 5   # Fix C: lowered from 15 — 15 was too aggressive for
                             # medium datasets (~3–5k rows split across 10 strata × 4
                             # categories).  Fix B's quantile-CDF fallback provides a
                             # safety net when cells are still too sparse.

        if self.target_type == "regression" and cat_cols:
            target_series = pd.to_numeric(df[self.label_col], errors="coerce")
            overall_mean  = float(target_series.mean())
            overall_var   = float(target_series.var())
            best_col, best_ratio = None, 0.0

            if overall_var > 0:
                for col in cat_cols:
                    s_col = df[col].dropna().astype(str)
                    if s_col.nunique() < 2:
                        continue
                    grp = pd.DataFrame({
                        "cat": s_col,
                        "val": pd.to_numeric(df.loc[s_col.index, self.label_col], errors="coerce"),
                    }).dropna()
                    if len(grp) < MIN_SUBGROUP_N * 2:
                        continue
                    grp_stats = grp.groupby("cat")["val"].agg(["mean", "count"])
                    between_var = float((
                        grp_stats["count"] / len(grp) *
                        (grp_stats["mean"] - overall_mean) ** 2
                    ).sum())
                    ratio = between_var / overall_var
                    if ratio > best_ratio:
                        best_col, best_ratio = col, ratio

                if best_col is not None and best_ratio > 0.05:
                    self.primary_target_cat_col = best_col

            # Build per-(stratum, category) quantile profiles
            if self.primary_target_cat_col:
                pcol = self.primary_target_cat_col
                for lv in label_values:
                    mask_lv = label_series == lv
                    sub_lv  = df[mask_lv]
                    cats_lv = sub_lv[pcol].dropna().astype(str).unique()
                    for cat in cats_lv:
                        rows = sub_lv[sub_lv[pcol].astype(str) == cat]
                        vals = pd.to_numeric(rows[self.label_col], errors="coerce").dropna()
                        if len(vals) < MIN_SUBGROUP_N:
                            continue
                        self.target_cat_quantiles[(self._norm_lv(lv), cat)] = {
                            "min":  float(vals.min()),
                            "max":  float(vals.max()),
                            "q01":  float(vals.quantile(0.01)),
                            "q05":  float(vals.quantile(0.05)),
                            "q25":  float(vals.quantile(0.25)),
                            "q50":  float(vals.quantile(0.50)),
                            "q75":  float(vals.quantile(0.75)),
                            "q95":  float(vals.quantile(0.95)),
                            "q99":  float(vals.quantile(0.99)),
                        }

        # Per-class covariance matrices for all numeric columns together
        if len(num_cols) >= 2:
            for lv in label_values:
                mask  = label_series == lv
                sub   = df[mask][num_cols].apply(_pd.to_numeric, errors="coerce").dropna()
                if len(sub) < len(num_cols) + 1:
                    continue
                mu  = sub.mean().values
                cov = sub.cov().values
                # FIX-12: shrink the sample covariance toward a scaled
                # identity matrix before the nearest-PD projection. The raw
                # sample covariance is highly noisy for small strata
                # (n_sub < 50 with 10+ numeric columns); _nearest_pd alone
                # only forces positive-definiteness, it doesn't reduce that
                # noise. Ledoit & Wolf (2004) shrinkage dominates the
                # sample covariance in MSE whenever p/n > 0.1.
                n_sub_cov   = len(sub)
                k_cols      = len(num_cols)
                trace_cov   = np.trace(cov) / k_cols
                shrink_alpha = min(1.0, k_cols / max(1, n_sub_cov - k_cols - 1))
                cov = (1 - shrink_alpha) * cov + shrink_alpha * trace_cov * np.eye(k_cols)
                cov = _nearest_pd(cov)
                self.class_covariance[self._norm_lv(lv)] = (mu, cov, num_cols)


# ==================================================================
# Section 2 — StatisticalEngine
# For small datasets (< 1 000 rows).
# Samples each column from its observed marginal distribution, then
# applies Cholesky-based covariance injection for strongly correlated
# numeric pairs.  No training step, no cache needed.
# ==================================================================

class StatisticalEngine:
    """
    Pure statistics-based generator.  Works entirely from the
    BaselineArtifact — does not load the original dataframe.

    Generation order (label-first when a label column is detected):
      1. Sample label values from the baseline marginal distribution.
      2. For each row, draw numeric features from per-class conditional
         distributions using quantile-preserving inverse-CDF sampling
         conditioned on the sampled label.
         Falls back to the global marginal spec when per-class stats are
         unavailable.
      3. Apply Cholesky copula injection to correlated numeric pairs
         within each class slice (rank → Z → Cholesky → Φ(Z) → Q⁻¹(U))
         to preserve intra-class feature correlations without distorting
         the marginal distributions.
      4. Sample categorical features conditioned on the label value using
         per-class frequency tables from class_cat_stats.

    Numeric sampling uses quantile-based inverse CDF — no rejection loop,
    no np.clip, preserves skew/tails from baseline quantile statistics.
    Categorical sampling uses multinomial draws from frequency tables.
    """

    ENGINE_NAME = "statistical"

    def __init__(self, bl: BaselineReader, rng: np.random.Generator) -> None:
        self.bl  = bl
        self.rng = rng

    def sample(self, n: int) -> pd.DataFrame:
        bl  = self.bl
        rng = self.rng

        data: Dict[str, np.ndarray] = {}

        if bl.label_col and bl.label_dist:
            # ---- Label-first path ----
            # 1. Sample labels
            label_choices = list(bl.label_dist.keys())
            label_probs   = np.array(list(bl.label_dist.values()), dtype=float)
            label_probs   = label_probs / label_probs.sum()
            labels        = np.array(label_choices, dtype=object)[
                rng.choice(len(label_choices), size=n, p=label_probs)
            ]
            data[bl.label_col] = labels

            # Fix 3: tracks whether primary_target_cat_col was pre-sampled.
            primary_col_values: Optional[np.ndarray] = None

            # 2a. Regression target: replace bin-index placeholder with an
            # actual continuous value conditioned on the primary categorical
            # column (Fix 3) or drawn uniformly inside the stratum range
            # (legacy fallback).
            if bl.target_type == "regression" and bl.regression_bin_edges is not None:
                edges = bl.regression_bin_edges
                pcol  = bl.primary_target_cat_col
                target_arr = np.empty(n, dtype=float)

                # Sample primary categorical column early
                if pcol and pcol in bl.categorical:
                    primary_col_values = np.empty(n, dtype=object)
                    for lv in label_choices:
                        mask_idx = np.where(labels == lv)[0]
                        if len(mask_idx) == 0:
                            continue
                        cls_freq = bl.class_cat_stats.get(pcol, {}).get(bl._norm_lv(lv))
                        if cls_freq:
                            choices = list(cls_freq.keys())
                            wts     = np.array(list(cls_freq.values()), dtype=float)
                            wts     = wts / wts.sum()
                            primary_col_values[mask_idx] = np.array(choices, dtype=object)[
                                rng.choice(len(choices), size=len(mask_idx), p=wts)
                            ]
                        else:
                            self._cond_sample_fallback_count = getattr(self, "_cond_sample_fallback_count", 0) + len(mask_idx)
                            primary_col_values[mask_idx] = self._sample_categorical_col(
                                pcol, bl.categorical.get(pcol, {}), len(mask_idx)
                            )
                    data[pcol] = primary_col_values

                for lv in label_choices:
                    mask = labels == lv
                    n_lv = int(mask.sum())
                    if n_lv == 0:
                        continue
                    mask_idx = np.where(mask)[0]
                    lo = float(edges[int(lv)])
                    hi = float(edges[int(lv) + 1]) if int(lv) + 1 < len(edges) else float(edges[-1])

                    # Fix B: helper — draw from global column CDF clipped to
                    # [lo, hi] instead of flat uniform; preserves within-bin
                    # distributional shape (tail skew, median, IQR).
                    def _cdf_fallback_stat(n_draw: int, lo=lo, hi=hi) -> np.ndarray:
                        col_spec = bl.numeric.get(bl.label_col, {})
                        fb_lvls, fb_vals = _build_quantile_cdf(col_spec)
                        if fb_lvls is not None and fb_vals[0] != fb_vals[-1]:
                            return np.clip(
                                _quantile_cdf_sample(n_draw, fb_lvls, fb_vals, rng),
                                lo, hi,
                            )
                        return rng.uniform(lo, hi, size=n_draw)

                    if primary_col_values is None:
                        target_arr[mask] = _cdf_fallback_stat(n_lv)
                        continue

                    cats_here = primary_col_values[mask_idx]
                    for cat in np.unique(cats_here):
                        sub_idx = mask_idx[cats_here == cat]
                        profile = bl.target_cat_quantiles.get((bl._norm_lv(lv), str(cat)))
                        if profile is None:
                            target_arr[sub_idx] = _cdf_fallback_stat(len(sub_idx))
                            continue
                        levels, values = _build_quantile_cdf(profile)
                        if levels is None or values[0] == values[-1]:
                            target_arr[sub_idx] = _cdf_fallback_stat(len(sub_idx))
                            continue
                        drawn = _quantile_cdf_sample(len(sub_idx), levels, values, rng)
                        target_arr[sub_idx] = np.clip(drawn, lo, hi)

                data[bl.label_col] = target_arr

            # 2b. Sample numeric features conditioned on label
            for col, spec in bl.numeric.items():
                if col == bl.label_col and bl.target_type == "regression":
                    continue  # already sampled above — do not overwrite
                arr = np.empty(n, dtype=float)
                for lv in label_choices:
                    mask   = labels == lv
                    n_lv   = int(mask.sum())
                    if n_lv == 0:
                        continue
                    cls_stats = bl.class_numeric_stats.get(col, {}).get(bl._norm_lv(lv))
                    # Pass the full per-class stats dict as a spec — it contains
                    # all quantile keys (q01…q99) so _sample_numeric_col can use
                    # quantile-CDF sampling rather than truncated normal.
                    cond_spec = cls_stats if cls_stats else spec
                    arr[mask] = self._sample_numeric_col(col, cond_spec, n_lv)
                data[col] = arr

            # 3. Cholesky covariance injection per label class
            data = self._inject_numeric_correlations_labeled(data, labels, label_choices)

            # 4. Sample categorical features (non-label) conditioned on label
            for col, spec in bl.categorical.items():
                if col == bl.label_col:
                    continue
                # Fix 3: primary categorical already sampled above — skip re-draw.
                if col == bl.primary_target_cat_col and primary_col_values is not None:
                    continue
                arr = np.empty(n, dtype=object)
                for lv in label_choices:
                    mask = labels == lv
                    n_lv = int(mask.sum())
                    if n_lv == 0:
                        continue
                    cls_freq = bl.class_cat_stats.get(col, {}).get(bl._norm_lv(lv))
                    if cls_freq:
                        choices = list(cls_freq.keys())
                        wts     = np.array(list(cls_freq.values()), dtype=float)
                        wts     = wts / wts.sum()
                        arr[mask] = np.array(choices, dtype=object)[
                            rng.choice(len(choices), size=n_lv, p=wts)
                        ]
                    else:
                        self._cond_sample_fallback_count = getattr(self, "_cond_sample_fallback_count", 0) + n_lv
                        arr[mask] = self._sample_categorical_col(col, spec, n_lv)
                data[col] = arr

        else:
            # ---- Unlabelled path (original behaviour) ----
            for col, spec in bl.numeric.items():
                data[col] = self._sample_numeric_col(col, spec, n)

            data = self._inject_numeric_correlations(data, n)

            for col, spec in bl.categorical.items():
                data[col] = self._sample_categorical_col(col, spec, n)

        # Other columns (datetime/object — emit None, constraint pass handles)
        for col in bl.other:
            data[col] = np.array([None] * n, dtype=object)

        # Apply null masks (FIX-08: correlated where bl.null_corr is
        # available, independent Bernoulli fallback otherwise; shared
        # with ProbabilisticEngine.sample() via _apply_null_masks)
        data = _apply_null_masks(bl, data, n, rng)

        return pd.DataFrame({col: data[col] for col in bl.col_order if col in data})

    # ------------------------------------------------------------------

    def _sample_numeric_col(
        self, col: str, spec: Dict[str, Any], n: int
    ) -> np.ndarray:
        """
        Sample n values using a piecewise-linear inverse CDF constructed
        from all available quantile statistics in the spec.

        This approach:
        • Preserves the full distribution shape — median, IQR, skew, tails
        • Is naturally bounded within [min, max] — no rejection, no clipping
        • Degrades gracefully: uses whatever quantile points are available
          (q01…q99 from baseline; mean as q50 fallback; min/max as 0/1)
        • Works for symmetric, skewed, and heavy-tailed distributions

        Falls back to uniform sampling only when min == max (degenerate column).
        """
        levels, values = _build_quantile_cdf(spec)

        if levels is None:
            # Not enough info — return zeros (schema preserved, values neutral)
            return np.zeros(n, dtype=float)

        lo, hi = values[0], values[-1]
        if lo == hi:
            return np.full(n, lo, dtype=float)

        return _quantile_cdf_sample(n, levels, values, self.rng)

    def _sample_categorical_col(
        self, col: str, spec: Dict[str, Any], n: int
    ) -> np.ndarray:
        """
        Sample n values from the observed frequency distribution.
        Prefers all_value_ratios (full distribution) over the truncated
        top_value_ratios when available (G3 fix).
        """
        rng    = self.rng
        # G3: use full distribution if stored, fall back to top-k
        ratios = spec.get("all_value_ratios") or spec.get("top_value_ratios") or {}

        if not ratios:
            return np.array([None] * n, dtype=object)

        choices = list(ratios.keys())
        weights = np.array(list(ratios.values()), dtype=float)
        if weights.sum() <= 0:
            weights = np.ones(len(choices), dtype=float)

        probs = weights / weights.sum()
        idx   = rng.choice(len(choices), size=n, p=probs)
        return np.array(choices, dtype=object)[idx]

    def _inject_numeric_correlations(
        self, data: Dict[str, np.ndarray], n: int
    ) -> Dict[str, np.ndarray]:
        """
        For strongly correlated numeric pairs (|Pearson r| >= 0.4),
        use Cholesky decomposition to introduce the observed covariance.
        Out-of-range values are resolved by resample-retry (not clipping)
        to avoid artificial boundary spikes.
        """
        return _apply_cholesky_correlations(data, self.bl, self.rng, n)

    def _inject_numeric_correlations_labeled(
        self,
        data:          Dict[str, np.ndarray],
        labels:        np.ndarray,
        label_values:  List[str],
    ) -> Dict[str, np.ndarray]:
        """
        Apply Cholesky covariance injection separately within each label
        class, using per-class covariance matrices when available.
        This preserves within-class feature correlations independently
        from between-class structure.
        """
        bl  = self.bl
        rng = self.rng
        n   = len(labels)

        num_cols_present = [c for c in bl.numeric if c in data]
        if bl.target_type == "regression" and bl.label_col in num_cols_present:
            # The target was already drawn from its stratum range in step 2a;
            # injecting Cholesky-based correlation here would overwrite that
            # value with one based on global/per-class covariance and could
            # push it outside its intended bin, breaking the label↔target link.
            num_cols_present = [c for c in num_cols_present if c != bl.label_col]
        if len(num_cols_present) < 2:
            return data

        for lv in label_values:
            mask = np.where(labels == lv)[0]
            n_lv = len(mask)
            if n_lv < 2:
                continue

            # Use per-class covariance if available, else global Pearson-based
            if bl._norm_lv(lv) in bl.class_covariance:
                mu, cov, col_names = bl.class_covariance[bl._norm_lv(lv)]
                cols_here = [c for c in col_names if c in data]
                if len(cols_here) < 2:
                    continue
                idx_in_cov = [col_names.index(c) for c in cols_here]
                mu_sub  = mu[idx_in_cov]
                cov_sub = cov[np.ix_(idx_in_cov, idx_in_cov)]
                cov_sub = _nearest_pd(cov_sub)
                try:
                    samples = rng.multivariate_normal(mu_sub, cov_sub, size=n_lv)
                except Exception:
                    continue
                for j, col in enumerate(cols_here):
                    spec = bl.numeric[col]
                    lo   = float(spec.get("min", -np.inf))
                    hi   = float(spec.get("max",  np.inf))
                    # Resample out-of-range values rather than clipping
                    col_samples = samples[:, j]
                    col_samples = _resample_out_of_range(col_samples, lo, hi, spec, rng)
                    data[col][mask] = col_samples
            else:
                # Fall back to global Cholesky on this class slice
                slice_data = {c: data[c][mask] for c in num_cols_present}
                slice_data = _apply_cholesky_correlations(slice_data, bl, rng, n_lv)
                for c in num_cols_present:
                    data[c][mask] = slice_data[c]

        return data


# ==================================================================
# Section 3 — ProbabilisticEngine
# For medium datasets (1 000 – 50 000 rows).
# Fits a Gaussian copula on the full dataframe: transforms numeric
# marginals to uniform via empirical CDF, fits a multivariate normal
# to the copula space, samples from it, then inverse-transforms back
# to original marginals.  Categorical columns are handled via
# conditional frequency tables keyed on their dominant numeric
# correlation partner (from point-biserial).
# ==================================================================

class ProbabilisticEngine:
    """
    Gaussian copula-based generator.

    Training  : fits a global copula on the original dataframe, plus
                per-class copulas when a label column is detected.
    Caching   : serialises all fitted parameters to pickle.
    Sampling  : label-first when label_col is set — sample label, then draw
                numeric features from the per-class copula, then draw
                categoricals from per-class frequency tables.
                Inverse-CDF transform brings values back to data space.
                No np.clip on generated values — out-of-range values are
                resolved by resample-retry.
    """

    ENGINE_NAME = "probabilistic"

    def __init__(
        self,
        bl:        BaselineReader,
        rng:       np.random.Generator,
        cache_dir: Optional[str] = None,
        manifest:  Optional["PreprocessingManifest"] = None,
    ) -> None:
        self.bl        = bl
        self.rng       = rng
        self.cache_dir = cache_dir

        # Global copula parameters
        self._mu          : Optional[np.ndarray]        = None
        self._cov         : Optional[np.ndarray]        = None
        self._cdfs        : Dict[str, Tuple]            = {}   # col → (sorted_vals, uniform_quantiles)
        self._cat_tables  : Dict[str, Dict]             = {}   # col → {bin_label → {value: prob}}
        self._num_cols    : List[str]                   = []

        # Per-class copula parameters (populated when label_col is detected)
        # label_value → {"mu": ndarray, "cov": ndarray, "cdfs": dict, "num_cols": list}
        self._class_copulas: Dict[str, Dict[str, Any]] = {}

        self._fitted      : bool                        = False

        # Preprocessing manifest integration
        self._manifest : Optional["PreprocessingManifest"] = manifest
        self._df_orig  : Optional[pd.DataFrame]            = None  # set by fit()

        # Engine-local cached fields (ISSUE 09 fix).
        # These are populated by fit() or load_cache() and consumed by
        # sample() and save_cache().  Previously load_cache() wrote these
        # directly to self.bl, leaking cache state into the shared
        # BaselineReader object used by other pipeline stages.
        self._label_col            : Optional[str]               = None
        self._label_dist           : Optional[Dict[str, float]]  = None
        self._class_cat_stats      : Dict[str, Dict]             = {}
        self._class_numeric_stats  : Dict[str, Dict]             = {}
        self._target_type          : Optional[str]               = None
        self._regression_bin_edges : Optional[np.ndarray]        = None
        self._primary_target_cat_col : Optional[str]             = None
        self._target_cat_quantiles : Dict[Tuple, Dict]           = {}

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def fit(self, df: pd.DataFrame) -> None:
        """Fit the Gaussian copula (global + per-class) on df."""
        bl = self.bl

        # Build per-class stats on the ORIGINAL df (not copula_df)
        # so class stats use real category values for label-first path.
        bl.build_class_stats(df)

        # Copy baseline-derived fields to engine-local storage (ISSUE 09).
        # This avoids leaking state back through the shared bl object.
        self._label_col            = bl.label_col
        self._label_dist           = bl.label_dist
        self._class_cat_stats      = bl.class_cat_stats
        self._class_numeric_stats  = bl.class_numeric_stats
        self._target_type          = bl.target_type
        self._regression_bin_edges = bl.regression_bin_edges
        self._primary_target_cat_col = bl.primary_target_cat_col
        self._target_cat_quantiles = bl.target_cat_quantiles

        # ── If manifest available: fit copula on copula_df ────────────
        if self._manifest is not None:
            self._df_orig = df  # store for apply_manifest calls in sample()
            copula_df, _ = apply_manifest(
                self._manifest, df, len(df), self.rng
            )
            self._num_cols = list(copula_df.columns)
            if bl.target_type == "regression" and bl.label_col in self._num_cols:
                # The regression target must not be modelled jointly inside the
                # Gaussian copula — it is sampled separately per stratum in
                # sample() (mirrors how a classification label_col, being
                # categorical, never enters the numeric copula in the first
                # place). Leaving it in here would let the copula overwrite
                # the stratum-conditioned target value drawn later.
                self._num_cols = [c for c in self._num_cols if c != bl.label_col]

            # Encoded categorical columns are kept in the copula to preserve joint
            # structure.  Their Z-scores cluster into K discrete levels (one per
            # category), which can make the covariance matrix near-singular.
            #
            # FIX-10: jitter is now calibrated to 10% of each column's minimum
            # inter-category gap (via its category_map — which already
            # reflects FIX-16's James-Stein shrinkage for pb_mean columns, so
            # the gap measured here is the real post-shrinkage spacing) rather
            # than a flat 1% of the column's std. A fixed 1% is negligible for
            # widely-spaced categories but can be 50%+ of the gap for tightly
            # clustered ones, causing frequent decode mis-snapping.
            #
            # Precondition fix: `enc_cols_to_jitter` previously compared
            # self._num_cols (encoded column names, e.g. "cat__enc") against
            # enc_col_set (original column names, e.g. "cat") -- these never
            # matched, so this jitter block silently never ran for any
            # encoded categorical column. Matching is now done via each
            # encoding's actual encoded_names, so the block (and FIX-10)
            # actually executes.
            if self._manifest.encoder is not None and hasattr(self._manifest.encoder, "_encodings"):
                encodings_by_encoded_name = {
                    enc.encoded_names[0]: enc
                    for enc in self._manifest.encoder._encodings.values()
                    if enc.strategy != "constant" and enc.encoded_names
                }
                enc_cols_to_jitter = [c for c in self._num_cols if c in encodings_by_encoded_name]
                if enc_cols_to_jitter:
                    copula_df = copula_df.copy()  # single copy (ISSUE 06 fix)
                for col in enc_cols_to_jitter:
                    cat_map = encodings_by_encoded_name[col].category_map
                    sorted_vals = sorted(cat_map.values())
                    min_gap = (
                        min(b - a for a, b in zip(sorted_vals, sorted_vals[1:]))
                        if len(sorted_vals) > 1 else 1.0
                    )
                    jitter_scale = max(min_gap * 0.1, 1e-4)
                    noise = self.rng.normal(0.0, jitter_scale, size=len(copula_df))
                    copula_df[col] = copula_df[col] + noise
        else:
            copula_df = df
            self._num_cols = [c for c in bl.numeric
                               if c in df.columns and
                               not (bl.target_type == "regression" and c == bl.label_col)]

        # ---- Global copula ----
        if self._num_cols:
            self._build_copula_from_df(copula_df, self._num_cols)

        # Remove any columns that failed copula/CDF construction.
        # Prevents stale latent dimensions from surviving in _num_cols.
        self._num_cols = [c for c in self._num_cols if c in self._cdfs]

        # ---- Per-class copulas (when label column detected) ----
        if bl.label_col and bl.label_col in df.columns and self._num_cols:
            if bl.target_type == "regression" and bl.regression_bin_edges is not None:
                # For regression, "classes" are the quantile strata computed by
                # build_class_stats() — NOT the raw continuous values, which
                # would each be (almost) unique and produce one-row "classes"
                # that always fail the min-rows-per-class check below.
                edges       = bl.regression_bin_edges
                target_vals = pd.to_numeric(df[bl.label_col], errors="coerce")
                strata      = np.clip(
                    np.digitize(target_vals, edges[1:-1]),
                    0, len(edges) - 2
                ).astype(str)
                label_series = pd.Series(strata, index=df.index)
            else:
                label_series = df[bl.label_col].astype(str)
            for lv in label_series.unique():
                sub_copula = copula_df.loc[label_series[label_series == lv].index]
                if len(sub_copula) < len(self._num_cols) + 2:
                    continue  # too few rows for reliable copula
                mu, cov, cdfs = self._fit_copula_params(sub_copula, self._num_cols)
                if mu is not None:
                    self._class_copulas[bl._norm_lv(lv)] = {
                        "mu":       mu,
                        "cov":      cov,
                        "cdfs":     cdfs,
                        "num_cols": self._num_cols,
                    }

        # Fit conditional categorical tables (still from df_orig for fallback)
        self._cat_tables = self._build_cat_tables(df)

        self._fitted = True

    def _build_copula_from_df(self, df: pd.DataFrame, num_cols: List[str]) -> None:
        """Fit global copula parameters; store in self._mu, _cov, _cdfs."""
        mu, cov, cdfs = self._fit_copula_params(df, num_cols)
        if mu is not None:
            self._mu   = mu
            self._cov  = cov
            self._cdfs = cdfs

    def _fit_copula_params(
        self,
        df:       pd.DataFrame,
        num_cols: List[str],
    ) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Dict[str, Tuple]]:
        """
        Fit copula parameters from df for the given numeric columns.
        Returns (mu, cov, cdfs) or (None, None, {}) on failure.
        """
        from scipy.special import ndtri  # type: ignore

        cdfs: Dict[str, Tuple] = {}
        for col in num_cols:
            s = pd.to_numeric(df[col], errors="coerce").dropna().sort_values()
            if len(s) < 2:
                return None, None, {}
            vals  = s.values
            quant = np.linspace(0.0, 1.0, len(vals))
            cdfs[col] = (vals, quant)

        U = np.column_stack([
            self._empirical_cdf_transform(df[c]) for c in num_cols
        ])

        # ISSUE 13 fix: exclude rows where ANY copula column is NaN in the
        # original data.  _empirical_cdf_transform maps NaN → 0.5 (median
        # quantile), which clusters those rows at Z=0 after probit transform,
        # inflating the density at the origin and biasing covariance → 0.
        valid_mask = df[num_cols].notna().all(axis=1).values
        n_valid = int(valid_mask.sum())
        # Guard: need at least num_cols+2 valid rows for a non-degenerate
        # covariance estimate; fall back to all rows (old behaviour) if not.
        if n_valid >= len(num_cols) + 2:
            U_fit = U[valid_mask]
        else:
            U_fit = U

        # Clamp strictly inside (0,1) for the probit transform — this is a
        # mathematical requirement of ndtri, not a data boundary clamp
        U_fit = np.clip(U_fit, 1e-6, 1.0 - 1e-6)
        Z = ndtri(U_fit)

        mu  = Z.mean(axis=0)
        cov = np.cov(Z, rowvar=False) if Z.shape[1] > 1 else np.array([[1.0]])
        cov = _nearest_pd(cov)
        return mu, cov, cdfs

    def sample(self, n: int) -> pd.DataFrame:
        if not self._fitted:
            raise RuntimeError("ProbabilisticEngine.fit() must be called before sample().")

        bl  = self.bl
        rng = self.rng

        # Engine-local aliases for cached fields (ISSUE 09 fix).
        # These may differ from bl.* when loaded from cache.
        label_col   = self._label_col
        label_dist  = self._label_dist
        target_type = self._target_type
        reg_edges   = self._regression_bin_edges
        pcol_name   = self._primary_target_cat_col
        ccs         = self._class_cat_stats
        tcq         = self._target_cat_quantiles

        data: Dict[str, np.ndarray] = {}

        if label_col and label_dist and self._class_copulas:
            # ---- Label-first path ----
            label_choices = list(label_dist.keys())
            label_probs   = np.array(list(label_dist.values()), dtype=float)
            label_probs   = label_probs / label_probs.sum()
            labels        = np.array(label_choices, dtype=object)[
                rng.choice(len(label_choices), size=n, p=label_probs)
            ]
            data[label_col] = labels

            # Fix 3: tracks whether primary_target_cat_col was pre-sampled
            # inside the regression block below. Initialized here so the
            # categorical-loop guard below is always valid regardless of path.
            primary_col_values: Optional[np.ndarray] = None

            # Regression target: emit an actual continuous value conditioned on
            # the strongest-correlated categorical column when available (Fix 3).
            # Falls back to flat rng.uniform(lo, hi) per stratum otherwise.
            if target_type == "regression" and reg_edges is not None:
                edges = reg_edges
                pcol  = pcol_name
                target_arr = np.empty(n, dtype=float)

                # Sample the primary categorical column early so target draw
                # can condition on it.
                if pcol and pcol in bl.categorical:
                    primary_col_values = np.empty(n, dtype=object)
                    for lv in label_choices:
                        idxs = np.where(labels == lv)[0]
                        if len(idxs) == 0:
                            continue
                        cls_freq = ccs.get(pcol, {}).get(bl._norm_lv(lv))
                        if cls_freq:
                            ch  = list(cls_freq.keys())
                            wts = np.array(list(cls_freq.values()), dtype=float)
                            wts = wts / wts.sum()
                            primary_col_values[idxs] = np.array(ch, dtype=object)[
                                rng.choice(len(ch), size=len(idxs), p=wts)
                            ]
                        else:
                            self._cond_sample_fallback_count = getattr(self, "_cond_sample_fallback_count", 0) + len(idxs)
                            primary_col_values[idxs] = self._sample_categorical_conditioned(
                                pcol, bl.categorical.get(pcol, {}), data, len(idxs)
                            )
                    data[pcol] = primary_col_values

                for lv in label_choices:
                    mask = np.where(labels == lv)[0]
                    n_lv = len(mask)
                    if n_lv == 0:
                        continue
                    lo = float(edges[int(lv)])
                    hi = float(edges[int(lv) + 1]) if int(lv) + 1 < len(edges) else float(edges[-1])

                    # Fix B: helper — draw from global column CDF clipped to
                    # [lo, hi] instead of flat uniform; preserves within-bin
                    # distributional shape (tail skew, median, IQR).
                    def _cdf_fallback_prob(n_draw: int, lo=lo, hi=hi) -> np.ndarray:
                        col_spec = bl.numeric.get(label_col, {})
                        fb_lvls, fb_vals = _build_quantile_cdf(col_spec)
                        if fb_lvls is not None and fb_vals[0] != fb_vals[-1]:
                            return np.clip(
                                _quantile_cdf_sample(n_draw, fb_lvls, fb_vals, rng),
                                lo, hi,
                            )
                        return rng.uniform(lo, hi, size=n_draw)

                    if primary_col_values is None:
                        target_arr[mask] = _cdf_fallback_prob(n_lv)
                        continue

                    cats_here = primary_col_values[mask]
                    for cat in np.unique(cats_here):
                        sub_idx = mask[cats_here == cat]
                        profile = tcq.get((bl._norm_lv(lv), str(cat)))
                        if profile is None:
                            target_arr[sub_idx] = _cdf_fallback_prob(len(sub_idx))
                            continue
                        levels, values = _build_quantile_cdf(profile)
                        if levels is None or values[0] == values[-1]:
                            target_arr[sub_idx] = _cdf_fallback_prob(len(sub_idx))
                            continue
                        drawn = _quantile_cdf_sample(len(sub_idx), levels, values, rng)
                        target_arr[sub_idx] = np.clip(drawn, lo, hi)

                data[label_col] = target_arr

            # Initialise numeric arrays to 0.0 — np.empty leaves uninitialized
            # memory that can be NaN on some platforms, causing NO_NAN violations
            # when a label class has no fitted copula and its rows are never written.
            for col in self._num_cols:
                data[col] = np.zeros(n, dtype=float)

            for lv in label_choices:
                mask = np.where(labels == lv)[0]
                n_lv = len(mask)
                if n_lv == 0:
                    continue

                copula = self._class_copulas.get(bl._norm_lv(lv))
                if copula is None:
                    # Fall back to global copula for unseen / rare labels
                    copula = {
                        "mu": self._mu, "cov": self._cov,
                        "cdfs": self._cdfs, "num_cols": self._num_cols,
                    }

                mu_lv   = copula["mu"]
                cov_lv  = copula["cov"]
                cdfs_lv = copula["cdfs"]
                cols_lv = copula["num_cols"]

                if mu_lv is None:
                    # Global copula also unavailable — fall back to independent
                    # marginal sampling so these rows are never left as NaN.
                    for col in self._num_cols:
                        spec = bl.numeric.get(col, {})
                        levels, values = _build_quantile_cdf(spec)
                        if levels is not None and values[0] != values[-1]:
                            data[col][mask] = _quantile_cdf_sample(n_lv, levels, values, rng)
                        # else: stays 0.0 (degenerate column)
                    continue

                # Sample from per-class copula
                from scipy.special import ndtr  # type: ignore
                Z_lv = rng.multivariate_normal(mu_lv, cov_lv, size=n_lv)
                # Clamp Z to prevent ndtr from returning exact 0/1 (mathematical guard)
                Z_lv = np.clip(Z_lv, -8.0, 8.0)
                U_lv = ndtr(Z_lv)

                for i, col in enumerate(cols_lv):
                    if col not in cdfs_lv:
                        continue
                    vals, quant = cdfs_lv[col]
                    spec        = bl.numeric.get(col, {})
                    lo          = float(spec.get("min", -np.inf))
                    hi          = float(spec.get("max",  np.inf))
                    generated   = np.interp(U_lv[:, i], quant, vals)
                    # Resample out-of-range values — no hard clip
                    generated   = _resample_out_of_range(generated, lo, hi, spec, rng)
                    data[col][mask] = generated

            # Post-loop guard: fix any column that is still all-NaN or
            # all-same (np.zeros init never overwritten by copula/marginal).
            # All-same triggers NUMERIC_COLLAPSE; all-NaN triggers NO_NAN.
            for col in self._num_cols:
                col_arr = data[col]
                spec = bl.numeric.get(col, {})

                nan_mask = np.isnan(col_arr)
                if nan_mask.any():
                    # Fill NaN positions via quantile CDF first
                    levels, values = _build_quantile_cdf(spec)
                    if levels is not None and values[-1] > values[0]:
                        n_nan = int(nan_mask.sum())
                        col_arr[nan_mask] = _quantile_cdf_sample(n_nan, levels, values, self.rng)
                    else:
                        fallback = float(spec.get("q50") or spec.get("mean") or 0.0)
                        col_arr[nan_mask] = fallback
                    data[col] = col_arr

                # If after NaN-fill the column is still all-same (e.g. all-zeros
                # from np.zeros that never got overwritten) AND the baseline shows
                # genuine variance, resample the whole column from the marginal.
                col_arr = data[col]
                bl_std = float(spec.get("std") or 0.0)
                if bl_std > 1e-3 and float(np.std(col_arr)) < 1e-9:
                    levels, values = _build_quantile_cdf(spec)
                    if levels is not None and values[-1] > values[0]:
                        data[col] = _quantile_cdf_sample(n, levels, values, self.rng)

            # Sample categorical features conditioned on label
            for col, spec in bl.categorical.items():
                if col == label_col:
                    continue
                # Fix 3: primary categorical already sampled above (conditioned
                # jointly with the regression target) — don't overwrite it.
                if col == pcol_name and primary_col_values is not None:
                    continue
                arr = np.empty(n, dtype=object)
                for lv in label_choices:
                    mask = np.where(labels == lv)[0]
                    n_lv = len(mask)
                    if n_lv == 0:
                        continue
                    cls_freq = ccs.get(col, {}).get(bl._norm_lv(lv))
                    if cls_freq:
                        ch  = list(cls_freq.keys())
                        wts = np.array(list(cls_freq.values()), dtype=float)
                        wts = wts / wts.sum()
                        arr[mask] = np.array(ch, dtype=object)[
                            rng.choice(len(ch), size=n_lv, p=wts)
                        ]
                    else:
                        self._cond_sample_fallback_count = getattr(self, "_cond_sample_fallback_count", 0) + n_lv
                        arr[mask] = self._sample_categorical_conditioned(
                            col, spec, data, n_lv
                        )
                data[col] = arr

        else:
            # ---- Unlabelled path ----
            if self._num_cols and self._mu is not None:
                from scipy.special import ndtr  # type: ignore
                Z_samples = rng.multivariate_normal(self._mu, self._cov, size=n)
                # Mathematical clamp to keep ndtr away from exact 0/1 only
                Z_samples = np.clip(Z_samples, -8.0, 8.0)
                U_samples = ndtr(Z_samples)

                for i, col in enumerate(self._num_cols):
                    vals, quant = self._cdfs[col]
                    spec        = bl.numeric.get(col, {})
                    lo          = float(spec.get("min", -np.inf))
                    hi          = float(spec.get("max",  np.inf))
                    generated   = np.interp(U_samples[:, i], quant, vals)
                    # Resample out-of-range values — no hard clip
                    data[col]   = _resample_out_of_range(generated, lo, hi, spec, rng)

            for col, spec in bl.categorical.items():
                data[col] = self._sample_categorical_conditioned(col, spec, data, n)

        # Other columns
        for col in bl.other:
            data[col] = np.array([None] * n, dtype=object)

        # ── If manifest: merge copula output with excluded columns ────
        if self._manifest is not None and self._df_orig is not None:
            # Encoded categorical columns are now part of self._num_cols and come
            # out of the Gaussian copula directly — no separate _enc_cdfs path.

            copula_output = pd.DataFrame(
                {col: data[col] for col in self._num_cols if col in data}
            )
            if (target_type == "regression" and label_col
                    and label_col in data
                    and label_col not in copula_output.columns):
                # Target was excluded from self._num_cols (sampled separately
                # by stratum above) — the manifest still treats it as a copula
                # column though, so merge_outputs() expects to find it among
                # copula_output's columns or it will raise ColumnMergeError.
                copula_output[label_col] = data[label_col]
            _, excluded_df = apply_manifest(
                self._manifest, self._df_orig, n, self.rng
            )
            # ColumnMergeError propagates — not caught
            return merge_outputs(
                copula_output, excluded_df, self._manifest, self.rng
            )

        # ── Legacy path (no manifest) ─────────────────────────────────
        # Null masks (FIX-08: correlated where available, see
        # _apply_null_masks / StatisticalEngine.sample())
        data = _apply_null_masks(bl, data, n, rng)

        return pd.DataFrame({col: data[col] for col in bl.col_order if col in data})

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    def cache_path(self) -> Optional[str]:
        if not self.cache_dir or not self.bl.fingerprint:
            return None
        return os.path.join(self.cache_dir, f"{self.bl.fingerprint}_probabilistic_v2.pkl")

    def save_cache(self) -> None:
        p = self.cache_path()
        if not p:
            return
        os.makedirs(self.cache_dir, exist_ok=True)  # type: ignore[arg-type]

        # Manifest column hash — allows cache invalidation when manifest changes
        manifest_sig = "noenc"
        if self._manifest is not None:
            _enc_cols = (
                self._manifest.encoder.columns_in_copula
                if self._manifest.encoder else []
            )
            enc_strategy_sig = {}
            if self._manifest.encoder is not None:
                if hasattr(self._manifest.encoder, "_encodings"):
                    enc_strategy_sig = {
                        col: enc.strategy
                        for col, enc in self._manifest.encoder._encodings.items()
                    }
            manifest_sig = hashlib.md5(
                str({
                    "cols":       sorted(self._manifest.copula_cols + _enc_cols),
                    "strategies": sorted(enc_strategy_sig.items()),
                }).encode()
            ).hexdigest()[:8]

        payload = {
            "mu":                  self._mu,
            "cov":                 self._cov,
            "cdfs":                self._cdfs,
            "cat_tables":          self._cat_tables,
            "num_cols":            self._num_cols,
            "class_copulas":       self._class_copulas,
            "label_col":           self._label_col,
            "label_dist":          self._label_dist,
            "class_cat_stats":     self._class_cat_stats,
            "class_numeric_stats": self._class_numeric_stats,
            "manifest_col_hash":   manifest_sig,
            "target_type":         self._target_type,
            "regression_bin_edges": (
                self._regression_bin_edges.tolist()
                if self._regression_bin_edges is not None else None
            ),
            # Fix 3: conditional regression target draw
            "primary_target_cat_col": self._primary_target_cat_col,
            "target_cat_quantiles": {
                f"{lv}||{cat}": profile
                for (lv, cat), profile in self._target_cat_quantiles.items()
            },
        }
        safe_dump(payload, p, cache_dir=self.cache_dir)

    def load_cache(self) -> bool:
        p = self.cache_path()
        if not p or not os.path.exists(p):
            return False
        try:
            payload = safe_load(p, cache_dir=self.cache_dir)

            # Verify manifest_col_hash matches current manifest
            cached_sig = payload.get("manifest_col_hash", "noenc")
            current_sig = "noenc"
            if self._manifest is not None:
                _enc_cols = (
                    self._manifest.encoder.columns_in_copula
                    if self._manifest.encoder else []
                )
                enc_strategy_sig = {}
                if self._manifest.encoder is not None:
                    if hasattr(self._manifest.encoder, "_encodings"):
                        enc_strategy_sig = {
                            col: enc.strategy
                            for col, enc in self._manifest.encoder._encodings.items()
                        }
                current_sig = hashlib.md5(
                    str({
                        "cols":       sorted(self._manifest.copula_cols + _enc_cols),
                        "strategies": sorted(enc_strategy_sig.items()),
                    }).encode()
                ).hexdigest()[:8]
            if cached_sig != current_sig:
                return False  # manifest changed — retrain

            self._mu            = payload["mu"]
            self._cov           = payload["cov"]
            self._cdfs          = payload["cdfs"]
            self._cat_tables    = payload["cat_tables"]
            self._num_cols      = payload["num_cols"]
            self._class_copulas = payload.get("class_copulas", {})
            # Write to engine-local fields — NOT to self.bl (ISSUE 09 fix).
            if payload.get("label_col"):
                self._label_col            = payload["label_col"]
                self._label_dist           = payload.get("label_dist", {})
                self._class_cat_stats      = payload.get("class_cat_stats", {})
                self._class_numeric_stats  = payload.get("class_numeric_stats", {})
            if payload.get("target_type"):
                self._target_type = payload["target_type"]
            _edges = payload.get("regression_bin_edges")
            if _edges is not None:
                self._regression_bin_edges = np.array(_edges)
            # Fix 3: restore conditional regression target draw state
            self._primary_target_cat_col = payload.get("primary_target_cat_col")
            _tcq = payload.get("target_cat_quantiles", {})
            self._target_cat_quantiles = {
                tuple(k.split("||", 1)): v for k, v in _tcq.items()
            }
            self._fitted        = True
            return True
        except SecurityError:
            # Tampered or unsigned cache — delete and regenerate
            try:
                os.unlink(p)
            except OSError:
                pass
            return False
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _empirical_cdf_transform(self, s: pd.Series) -> np.ndarray:
        """Map each value to its empirical quantile in [0, 1].
        NaN positions are excluded from ranking and filled with 0.5."""
        numeric = pd.to_numeric(s, errors="coerce")
        n       = len(numeric)
        mask    = numeric.notna()
        n_valid = int(mask.sum())
        result  = np.full(n, 0.5)
        if n_valid > 0:
            sub_ranks = numeric[mask].rank(method="average")
            result[mask.values] = sub_ranks.values / n_valid
        return result

    def _build_cat_tables(self, df: pd.DataFrame) -> Dict[str, Dict]:
        """
        Build conditional frequency tables for each categorical column.
        For each categorical col with a strong point-biserial partner,
        bin the numeric partner into quartiles and store per-bin value
        frequency.  Falls back to unconditional frequency if no strong
        partner exists.
        """
        bl     = self.bl
        tables = {}

        strong_pb = {cat: (num, r) for cat, num, r in bl.strong_pb_pairs(threshold=0.3)}

        for col, spec in bl.categorical.items():
            if col not in df.columns:
                continue

            if col in strong_pb:
                num_col, _ = strong_pb[col]
                if num_col in df.columns:
                    num_series = pd.to_numeric(df[num_col], errors="coerce")
                    cat_series = df[col].astype(str)
                    # FIX-04: adaptive bin count instead of a fixed q=4,
                    # via the shared _adaptive_bin_count helper (see
                    # module-level docstring; also used by FIX-15's
                    # regression target binning). Too few bins wastes
                    # resolution on large datasets; too many starves small
                    # ones of rows per contingency cell.
                    n_valid = int(num_series.dropna().count())
                    n_cats  = len(cat_series.dropna().unique())
                    q = _adaptive_bin_count(n_valid, n_cats)
                    # FIX-01: retain the qcut bin edges so sampling can use
                    # np.digitize with the SAME edges (equal-count quantile
                    # boundaries) instead of a linear (equal-width) rescale,
                    # which silently mismatched for skewed partners.
                    bins, edges = pd.qcut(
                        num_series, q=q, labels=False, duplicates="drop", retbins=True
                    )
                    table: Dict[str, Dict[str, float]] = {}
                    # FIX-14: shrink each per-bin frequency table toward the
                    # column's global (unconditional) frequency, using the
                    # shared _shrink_freq_table helper (same empirical-Bayes
                    # scheme as FIX-02's build_class_stats; k_scale=10
                    # matches the originally-approved per-bin formula
                    # k_shrink = max(1, n_cats/5) * 10). Raw per-bin MLE
                    # frequencies give unseen categories P=0 in that bin --
                    # they can then never be generated for numeric values in
                    # that range, even though they exist elsewhere in the
                    # column.
                    global_freq = cat_series.value_counts(normalize=True).to_dict()
                    for bin_label in bins.dropna().unique():
                        mask  = bins == bin_label
                        sub   = cat_series[mask]
                        vc    = sub.value_counts(normalize=True).to_dict()
                        table[str(int(bin_label))] = _shrink_freq_table(
                            vc, global_freq, len(sub), k_scale=10
                        )
                    tables[col] = {
                        "type": "conditional",
                        "partner": num_col,
                        "bins": table,
                        "edges": edges.tolist(),  # FIX-01
                    }
                    continue

            # Unconditional frequency table
            # FIX-03: prefer full-distribution ratios over the truncated
            # top-10 table so long-tail categories aren't silently dropped.
            ratios = spec.get("all_value_ratios") or spec.get("top_value_ratios") or {}
            tables[col] = {"type": "unconditional", "ratios": ratios}

        return tables

    def _sample_categorical_conditioned(
        self,
        col:  str,
        spec: Dict[str, Any],
        data: Dict[str, np.ndarray],
        n:    int,
    ) -> np.ndarray:
        """
        Sample a categorical column, conditioning on its numeric partner
        (if one exists in the fitted cat_tables).
        G9: inner per-row loop replaced with vectorized bin-group sampling.
        """
        rng   = self.rng
        table = self._cat_tables.get(col)

        if table is None or table["type"] == "unconditional":
            ratios  = spec.get("all_value_ratios") or spec.get("top_value_ratios") or {}
            if not ratios:
                return np.array([None] * n, dtype=object)
            choices = list(ratios.keys())
            weights = np.array(list(ratios.values()), dtype=float)
            weights = weights / weights.sum()
            return np.array(choices, dtype=object)[rng.choice(len(choices), size=n, p=weights)]

        # Conditional: bin the already-generated numeric partner values
        partner     = table["partner"]
        bins_table  = table["bins"]
        partner_arr = data.get(partner)

        if partner_arr is None or len(bins_table) == 0:
            # Fall back to unconditional
            ratios  = spec.get("all_value_ratios") or spec.get("top_value_ratios") or {}
            choices = list(ratios.keys()) if ratios else [None]
            weights = np.array(list(ratios.values()), dtype=float) if ratios else np.array([1.0])
            weights = weights / weights.sum()
            return np.array(choices, dtype=object)[rng.choice(len(choices), size=n, p=weights)]

        # Determine which quantile each generated numeric value falls into
        partner_spec = self.bl.numeric.get(partner, {})
        lo  = float(partner_spec.get("min", partner_arr.min()))
        hi  = float(partner_spec.get("max", partner_arr.max()))
        rng_span = hi - lo if hi > lo else 1.0
        result   = np.empty(n, dtype=object)

        bin_keys  = sorted(bins_table.keys(), key=lambda x: int(x))
        n_bins    = len(bin_keys)

        # partner_arr is a float array, so use np.isnan not == None.
        partner_float = partner_arr.astype(float)
        nan_mask      = np.isnan(partner_float)
        vals          = np.where(nan_mask, lo, partner_float)

        # FIX-01: use the qcut bin edges saved at fit time (np.digitize)
        # instead of a linear/equal-width rescale, which mismatched the
        # equal-count quantile bins used to build `bins_table` and biased
        # every conditional probability for skewed numeric partners.
        # Old caches without "edges" fall back to the previous linear
        # rescale for backward compatibility.
        edges = np.array(table.get("edges", []))
        if len(edges) > 1:
            # Interior edges only (drop the outer min/max boundaries);
            # np.digitize then returns values in [0, n_bins - 1].
            bin_indices = np.clip(np.digitize(vals, edges[1:-1]), 0, n_bins - 1)
        else:
            bin_indices = np.clip(
                ((vals - lo) / rng_span * n_bins).astype(int), 0, n_bins - 1
            )

        # Global marginal fallback (for empty conditional bins)
        # FIX-03: prefer full-distribution ratios over the truncated
        # top-10 table so long-tail categories aren't silently dropped.
        ratios_fb = spec.get("all_value_ratios") or spec.get("top_value_ratios") or {}
        fb_choices = list(ratios_fb.keys()) if ratios_fb else []
        fb_weights = (np.array(list(ratios_fb.values()), dtype=float)
                      if ratios_fb else np.array([]))
        if len(fb_weights) > 0:
            fb_weights = fb_weights / fb_weights.sum()

        # Per-bin vectorized sampling
        for bi, bin_key in enumerate(bin_keys):
            mask    = bin_indices == bi
            n_in_bin = int(mask.sum())
            if n_in_bin == 0:
                continue
            freq = bins_table[bin_key]
            if freq:
                ch = list(freq.keys())
                wt = np.array(list(freq.values()), dtype=float)
                wt = wt / wt.sum()
                result[mask] = np.array(ch, dtype=object)[
                    rng.choice(len(ch), size=n_in_bin, p=wt)
                ]
            elif len(fb_choices) > 0:
                result[mask] = np.array(fb_choices, dtype=object)[
                    rng.choice(len(fb_choices), size=n_in_bin, p=fb_weights)
                ]
            else:
                result[mask] = None

        return result


# ==================================================================
# Section 4 — CTGANEngine
# For large datasets (>= 50 000 rows).
# Trains a CTGANSynthesizer on the full dataframe.
# Falls back to ProbabilisticEngine if ctgan is not installed.
# Caches the trained model to disk keyed by dataset fingerprint.
# ==================================================================

class CTGANEngine:
    """
    CTGAN-based generator for large datasets.

    If ctgan is not installed, automatically falls back to
    ProbabilisticEngine with a warning in the output.
    """

    ENGINE_NAME = "ctgan"

    def __init__(
        self,
        bl:        BaselineReader,
        rng:       np.random.Generator,
        cache_dir: Optional[str] = None,
        manifest:  Optional["PreprocessingManifest"] = None,
    ) -> None:
        self.bl         = bl
        self.rng        = rng
        self.cache_dir  = cache_dir
        self._model     = None
        self._fitted    = False
        self._fallback  : Optional[ProbabilisticEngine] = None

        # Preprocessing manifest integration
        self._manifest   : Optional["PreprocessingManifest"] = manifest
        self._df_orig    : Optional[pd.DataFrame]            = None
        self._ctgan_cols : Optional[List[str]]               = None

        if not _CTGAN_AVAILABLE:
            self._fallback = ProbabilisticEngine(
                bl, rng, cache_dir, manifest=manifest
            )

    def fit(self, df: pd.DataFrame) -> None:
        if self._fallback is not None:
            if not self._fallback.load_cache():
                self._fallback.fit(df)
                self._fallback.save_cache()
            else:
                self._fallback._df_orig = df  # Restore for manifest path on cache hit
            self._fitted = True
            return

        # ── Manifest path: fit CTGAN on copula_df ─────────────────────
        if self._manifest is not None:
            self._df_orig = df
            _fit_rng = self.rng  # G10: use user-supplied rng for reproducibility
            copula_df, _ = apply_manifest(
                self._manifest, df, len(df), _fit_rng
            )
            self._ctgan_cols = list(copula_df.columns)
            # Encoded categoricals are continuous — no discrete_columns
            self._model = CTGANSynthesizer(epochs=300, verbose=False)
            self._model.fit(copula_df, discrete_columns=[])
        else:
            # Legacy: pass full df with baseline categorical columns as discrete
            discrete_cols = list(self.bl.categorical.keys())
            self._model = CTGANSynthesizer(epochs=300, verbose=False)
            self._model.fit(df, discrete_columns=discrete_cols)
            self._ctgan_cols = None

        self._fitted = True

    def sample(self, n: int) -> pd.DataFrame:
        if not self._fitted:
            raise RuntimeError("CTGANEngine.fit() must be called before sample().")

        if self._fallback is not None:
            return self._fallback.sample(n)

        raw = self._model.sample(n)

        # ── Manifest path: decode via merge_outputs ───────────────────
        if (self._manifest is not None
                and self._df_orig is not None
                and self._ctgan_cols):
            copula_output = raw[
                [c for c in self._ctgan_cols if c in raw.columns]
            ]
            _, excluded_df = apply_manifest(
                self._manifest, self._df_orig, n, self.rng
            )
            # ColumnMergeError propagates — not caught
            return merge_outputs(
                copula_output, excluded_df, self._manifest, self.rng
            )

        # ── Legacy path: reorder columns to match baseline col_order ──
        present = [c for c in self.bl.col_order if c in raw.columns]
        return raw[present]

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    def cache_path(self) -> Optional[str]:
        if not self.cache_dir or not self.bl.fingerprint:
            return None
        return os.path.join(self.cache_dir, f"{self.bl.fingerprint}_ctgan.pkl")

    def save_cache(self) -> None:
        if self._fallback is not None:
            self._fallback.save_cache()
            return
        p = self.cache_path()
        if not p or self._model is None:
            return
        os.makedirs(self.cache_dir, exist_ok=True)  # type: ignore[arg-type]
        safe_dump(self._model, p, cache_dir=self.cache_dir)

    def load_cache(self) -> bool:
        if self._fallback is not None:
            return self._fallback.load_cache()
        p = self.cache_path()
        if not p or not os.path.exists(p):
            return False
        try:
            self._model  = safe_load(p, cache_dir=self.cache_dir)
            self._fitted = True
            return True
        except SecurityError:
            try:
                os.unlink(p)
            except OSError:
                pass
            return False
        except Exception:
            return False

    @property
    def engine_used(self) -> str:
        """Actual engine name (accounts for fallback)."""
        if self._fallback is not None:
            return ProbabilisticEngine.ENGINE_NAME
        return self.ENGINE_NAME


# ==================================================================
# Sections 5, 6, 7 — ConstraintFilter, RowQualityFilter,
#                     DuplicatePreFilter
#
# These classes have been moved to validation.py and are accessed
# via the ValidationLayer unified interface imported at the top of
# this file.
# ==================================================================


# ==================================================================
# Section 8 — Engine router + generate()
# Public entry point.  Selects the right engine, trains if needed,
# then runs the ValidationLayer retry loop with CheckPoint commits.
#
# Retry loop
# ----------
# Each round: engine.sample() → ValidationLayer.run() →
#             CheckPoint.commit() until n accepted rows or max rounds.
# CheckPoint.seal() is called once at the very end.
# ==================================================================


def generate(
    dataset_path:    str,
    baseline_path:   str,
    n:               int,
    cache_dir:       Optional[str] = None,
    seed:            Optional[int] = None,
    engine_override: Optional[str] = None,  # E1: allow caller to force engine
) -> Dict[str, Any]:
    """
    Full generation pipeline.

    Parameters
    ----------
    dataset_path  : path to the original dataset file
    baseline_path : path to the BaselineArtifact JSON file
    n             : number of synthetic rows to generate
    cache_dir     : directory for model cache and checkpoint files
    seed          : random seed for reproducibility

    Returns
    -------
    dict  {samples, generator_used, row_count,
           dataset_fingerprint, warnings, checkpoint_path}

    The checkpoint_path key lets the background agent locate the
    CheckPoint file without any additional coordination.
    """
    output_warnings: List[str] = []

    # ════════════════════════════════════════════════════════════════
    # BACKPRESSURE GATE — acquire execution slot before any work
    # Raises PipelineHardFail immediately if queue is full or timeout.
    # ════════════════════════════════════════════════════════════════
    import uuid as _uuid
    _slot_run_id = f"gen-{_uuid.uuid4().hex[:12]}"
    with pipeline_slot(_slot_run_id):
        return _generate_inner(
            dataset_path    = dataset_path,
            baseline_path   = baseline_path,
            n               = n,
            cache_dir       = cache_dir,
            seed            = seed,
            output_warnings = output_warnings,
            engine_override = engine_override,
        )


def _generate_inner(
    dataset_path:    str,
    baseline_path:   str,
    n:               int,
    cache_dir:       Optional[str],
    seed:            Optional[int],
    output_warnings: List[str],
    engine_override: Optional[str] = None,  # E1
) -> Dict[str, Any]:
    """
    Inner pipeline body — called inside the execution slot.
    All enforcement, generation, and gate logic lives here.
    """
    # ════════════════════════════════════════════════════════════════
    # LOAD SYNTHETIC POLICY (policy.yaml synthetic_data section)
    # Done before seed resolution so default_seed can apply.
    # ════════════════════════════════════════════════════════════════
    synthetic_policy = _load_synthetic_policy(dataset_path)

    # Apply default_seed from policy when caller did not supply one
    if seed is None and synthetic_policy.get("default_seed") is not None:
        try:
            seed = int(synthetic_policy["default_seed"])
            output_warnings.append(
                f"Seed not specified — using policy default_seed={seed}."
            )
        except (TypeError, ValueError):
            pass
    # ════════════════════════════════════════════════════════════════
    # ENFORCEMENT LAYER — Phase 0: initialise determinism + config
    # ════════════════════════════════════════════════════════════════
    # 1. Resolve and record seed FIRST — before any random operation.
    root_rng, resolved_seed = _seed_mgr.init(seed)

    # 2. Load baseline
    with open(baseline_path, "r", encoding="utf-8") as f:
        artifact = json.load(f)

    bl  = BaselineReader(artifact)
    rng = _seed_mgr.spawn(root_rng, "main_loop")

    # Ensure fingerprint is never empty — empty fingerprints produce identical cache keys
    if not bl.fingerprint:
        bl.fingerprint = hashlib.md5(dataset_path.encode()).hexdigest()[:16]

    # 3. Route to engine
    row_count = bl.row_count
    # E1: respect user-supplied engine override, otherwise auto-select by size
    if engine_override and engine_override not in ("auto", None):
        engine_name = engine_override
        _engine_reason = (
            f"Forced by --engine flag. "
            f"Dataset rows: {row_count}."
        )
        output_warnings.append(
            f"Engine overridden by caller: '{engine_name}' "
            f"(dataset rows: {row_count}, requested samples: {n})."
        )
    elif row_count < _SMALL_THRESHOLD:
        engine_name    = StatisticalEngine.ENGINE_NAME
        _engine_reason = (
            f"Dataset has {row_count:,} rows (threshold: {_SMALL_THRESHOLD:,}). "
            f"Tip: use --engine probabilistic to override, or add more rows."
        )
    elif row_count < _LARGE_THRESHOLD:
        engine_name    = ProbabilisticEngine.ENGINE_NAME
        _engine_reason = (
            f"Dataset has {row_count:,} rows "
            f"({_SMALL_THRESHOLD:,}–{_LARGE_THRESHOLD:,} row range → ProbabilisticEngine)."
        )
    else:
        engine_name    = CTGANEngine.ENGINE_NAME
        _engine_reason = (
            f"Dataset has {row_count:,} rows (≥{_LARGE_THRESHOLD:,} → CTGANEngine)."
        )

    output_warnings.append(
        f"Engine selected: {engine_name} "
        f"(dataset rows: {row_count}, requested samples: {n})."
    )

    # 4. Freeze config snapshot (immutable from here on)
    import uuid as _uuid
    run_id   = _uuid.uuid4().hex[:12]
    snap     = _cfg_snap.create(
        run_id        = run_id,
        dataset_path  = dataset_path,
        baseline_path = baseline_path,
        n             = n,
        seed          = resolved_seed,
        engine        = engine_name,
        cache_dir     = cache_dir,
    )

    # 5. Initialise audit logger
    _cache_dir = cache_dir or os.path.join(os.path.dirname(baseline_path), "cache")
    os.makedirs(_cache_dir, exist_ok=True)
    audit_path = os.path.join(_cache_dir, f"{bl.fingerprint}_{run_id}_audit.jsonl")
    logger     = _audit_mod.init(run_id=run_id, path=audit_path)
    logger.log(
        stage   = "generate",
        event   = "START",
        metrics = {"seed": resolved_seed, "n_requested": n,
                   "engine": engine_name, "config_hash": snap.config_hash},
    )

    # 6. Initialise enforcement engine (gating ALL stages)
    enforcer = _enforce_mod.init(
        bl          = bl,
        n_requested = n,
        run_id      = run_id,
        logger      = logger,
    )
    enforcer.record_seed(resolved_seed)
    enforcer.record_config_hash(snap.config_hash)

    # ════════════════════════════════════════════════════════════════
    # CheckPoint setup
    # ════════════════════════════════════════════════════════════════
    cp_path = CheckPoint.default_path(_cache_dir, bl.fingerprint)
    cp = CheckPoint(
        path                = cp_path,
        n_requested         = n,
        dataset_fingerprint = bl.fingerprint,
        generator_used      = engine_name,
    )
    cp.reset()

    # ════════════════════════════════════════════════════════════════
    # Load original dataset ONCE — shared by manifest, engine, dedup
    # ════════════════════════════════════════════════════════════════
    try:
        df_orig = _load_original(dataset_path, bl)
    except Exception as _load_exc:
        raise PipelineHardFail(
            message=f"Cannot load original dataset: {_load_exc}",
            stage="load_original",
            context={"path": dataset_path},
        )

    # ════════════════════════════════════════════════════════════════
    # Build preprocessing manifest (6-type taxonomy + CategoricalEncoder)
    # Only for engines that consume it (ProbabilisticEngine, CTGANEngine).
    # StatisticalEngine does not accept a manifest — skip wasted work.
    # ════════════════════════════════════════════════════════════════
    manifest = None
    if engine_name != StatisticalEngine.ENGINE_NAME:
        manifest = build_manifest(
            df_orig, artifact, overrides=synthetic_policy,
            target_type=bl.target_type, target_col=bl.label_col,
        )
        if manifest.warnings:
            for _w in manifest.warnings:
                output_warnings.append(f"[preprocessing] {_w}")

    # ════════════════════════════════════════════════════════════════
    # Build and train engine
    # ════════════════════════════════════════════════════════════════
    with logger.stage("engine_build") as ctx_eng:
        if engine_name == StatisticalEngine.ENGINE_NAME:
            engine = StatisticalEngine(bl, _seed_mgr.spawn(root_rng, "statistical"))
            # FIX-08: build_class_stats() also computes the cross-column
            # null-correlation matrix, which (unlike class-conditional
            # stats) is a whole-dataset property independent of label_col.
            # The call itself therefore now runs unconditionally; only the
            # label-specific warnings/sanity-checks below remain gated.
            try:
                bl.build_class_stats(df_orig)
                if bl.label_col:
                    output_warnings.append(
                        f"Label column detected (\'{bl.label_col}\'): "
                        "class-conditional statistics built for label-first generation."
                    )
                    # Step C: sanity-check class_cat_stats coverage after build
                    if bl.primary_target_cat_col:
                        _pcol = bl.primary_target_cat_col
                        _stats = bl.class_cat_stats.get(_pcol, {})
                        _n_strata_with_data = len(_stats)
                        _n_strata_expected = len(bl.label_dist)
                        if _n_strata_with_data < _n_strata_expected:
                            output_warnings.append(
                                f"class_cat_stats['{_pcol}'] only has {_n_strata_with_data}/"
                                f"{_n_strata_expected} strata populated — per-stratum "
                                "conditioning will silently fall back for missing strata."
                            )
                        _keys_sorted = sorted(_stats.keys(), key=lambda k: int(k) if k.isdigit() else 0)
                        if len(_keys_sorted) >= 2:
                            _low  = _stats[_keys_sorted[0]]
                            _high = _stats[_keys_sorted[-1]]
                            _overlap = sum(min(_low.get(c, 0), _high.get(c, 0)) for c in set(_low) | set(_high))
                            if _overlap > 0.9:
                                output_warnings.append(
                                    f"class_cat_stats['{_pcol}'] shows <10% difference "
                                    f"between lowest and highest stratum — conditioning may "
                                    f"not be taking effect (expected strong skew for "
                                    f"primary_target_cat_col by definition)."
                                )
            except Exception as e:
                output_warnings.append(
                    f"Could not build class stats "
                    f"(falling back to marginal distributions): {e}"
                )
            actual_engine = StatisticalEngine.ENGINE_NAME

        elif engine_name == ProbabilisticEngine.ENGINE_NAME:
            engine = ProbabilisticEngine(
                bl, _seed_mgr.spawn(root_rng, "probabilistic"),
                _cache_dir, manifest=manifest,
            )
            if not engine.load_cache():
                engine.fit(df_orig)
                engine.save_cache()
                output_warnings.append("Probabilistic model fitted and cached.")
                if bl.label_col:
                    output_warnings.append(
                        f"Label column detected (\'{bl.label_col}\'): "
                        "per-class copulas fitted for label-first generation."
                    )
                # Step C: sanity-check class_cat_stats coverage after fit (which calls build_class_stats)
                if bl.primary_target_cat_col:
                    _pcol = bl.primary_target_cat_col
                    _stats = bl.class_cat_stats.get(_pcol, {})
                    _n_strata_with_data = len(_stats)
                    _n_strata_expected = len(bl.label_dist)
                    if _n_strata_with_data < _n_strata_expected:
                        output_warnings.append(
                            f"class_cat_stats['{_pcol}'] only has {_n_strata_with_data}/"
                            f"{_n_strata_expected} strata populated — per-stratum "
                            "conditioning will silently fall back for missing strata."
                        )
                    _keys_sorted = sorted(_stats.keys(), key=lambda k: int(k) if k.isdigit() else 0)
                    if len(_keys_sorted) >= 2:
                        _low  = _stats[_keys_sorted[0]]
                        _high = _stats[_keys_sorted[-1]]
                        _overlap = sum(min(_low.get(c, 0), _high.get(c, 0)) for c in set(_low) | set(_high))
                        if _overlap > 0.9:
                            output_warnings.append(
                                f"class_cat_stats['{_pcol}'] shows <10% difference "
                                f"between lowest and highest stratum — conditioning may "
                                f"not be taking effect (expected strong skew for "
                                f"primary_target_cat_col by definition)."
                            )
            else:
                engine._df_orig = df_orig  # Restore for manifest path on cache hit
                output_warnings.append("Probabilistic model loaded from cache.")
            actual_engine = ProbabilisticEngine.ENGINE_NAME

        else:  # ctgan
            engine = CTGANEngine(
                bl, _seed_mgr.spawn(root_rng, "ctgan"),
                _cache_dir, manifest=manifest,
            )
            if not engine.load_cache():
                engine.fit(df_orig)
                engine.save_cache()
                output_warnings.append("CTGAN model fitted and cached.")
            else:
                engine._df_orig = df_orig  # Restore for manifest path on cache hit
                # Also restore on fallback ProbabilisticEngine if present
                if engine._fallback is not None:
                    engine._fallback._df_orig = df_orig
                output_warnings.append("CTGAN model loaded from cache.")
            actual_engine = engine.engine_used
            if actual_engine != CTGANEngine.ENGINE_NAME:
                output_warnings.append(
                    "ctgan package not installed — fell back to ProbabilisticEngine. "
                    "Install with: pip install ctgan"
                )
        ctx_eng.warnings = output_warnings[:]

    # ════════════════════════════════════════════════════════════════
    # Build ValidationLayer
    # ════════════════════════════════════════════════════════════════
    with logger.stage("validation_build") as ctx_vb:
        df_orig_for_dedup = df_orig  # already loaded above
        ctx_vb.output_rows = len(df_orig_for_dedup)

        vl = ValidationLayer(
            bl           = bl,
            rng          = _seed_mgr.spawn(root_rng, "validation"),
            original_df  = df_orig_for_dedup,
            max_failures = 1,
        )

    # ════════════════════════════════════════════════════════════════
    # Retry loop: engine → validate → ENFORCE → CheckPoint
    # ════════════════════════════════════════════════════════════════
    cp_seal_status = "complete"

    def _fill_nan_numeric(df: pd.DataFrame) -> pd.DataFrame:
        """
        Universal NaN guard + integer rounding — runs after every engine.sample() call.

        NaN guard: any numeric column whose baseline null_ratio == 0 must never contain
        NaN in the generated batch.  Several engine paths can silently produce NaN before
        reaching the invariant checker.  Strategy: fill with q50 → mean → min → 0.

        Integer rounding: if the baseline recorded is_integer=True for a column
        (e.g. Age, Year, Count), all generated float values are rounded to the
        nearest integer so the output never contains nonsensical floats like 34.7
        or 2022.4.  Columns where the original data contained genuine fractions
        are left untouched.
        """
        needs_copy = False
        for col in bl.numeric:
            if col not in df.columns:
                continue
            has_intentional_nulls = bl.null_ratio(col) > 0.0
            numeric_col = pd.to_numeric(df[col], errors="coerce")
            nan_mask = numeric_col.isna()

            # ── NaN fill ─────────────────────────────────────────────────
            if not has_intentional_nulls and nan_mask.any():
                col_spec_nan = bl.numeric.get(col) or {}
                if isinstance(col_spec_nan, dict):
                    fallback = (
                        col_spec_nan.get("q50") or col_spec_nan.get("median") or
                        col_spec_nan.get("mean") or col_spec_nan.get("min") or 0.0
                    )
                else:
                    fallback = (
                        getattr(col_spec_nan, "q50", None) or
                        getattr(col_spec_nan, "mean", None) or
                        getattr(col_spec_nan, "min", None) or 0.0
                    )
                if not needs_copy:
                    df = df.copy()
                    needs_copy = True
                numeric_col = numeric_col.fillna(float(fallback))
                df[col] = numeric_col

            # ── Integer rounding ─────────────────────────────────────────
            col_spec = bl.numeric.get(col)
            if col_spec is not None:
                if isinstance(col_spec, dict):
                    is_int_col = bool(col_spec.get("is_integer", False))
                else:
                    is_int_col = bool(getattr(col_spec, "is_integer", False))

                if is_int_col:
                    if not needs_copy:
                        df = df.copy()
                        needs_copy = True
                    col_vals = pd.to_numeric(df[col], errors="coerce")
                    if has_intentional_nulls:
                        # Preserve NaN for nullable integer columns
                        df[col] = col_vals.apply(
                            lambda v: int(round(v)) if pd.notna(v) else v
                        )
                    else:
                        df[col] = col_vals.round(0).astype("Int64").astype(object)

        return df

    # D2: Load constraint rules once before the round loop.
    # Rules are defined in policy.yaml synthetic_data.constraint_rules.
    _constraint_rules = load_constraint_rules(dataset_path)
    if _constraint_rules:
        output_warnings.append(
            f"[ConstraintEnforcer] {len(_constraint_rules)} cross-column rule(s) loaded."
        )

    for round_idx in range(_MAX_QUALITY_ROUNDS):
        still_need = n - cp.n_collected
        if still_need <= 0:
            break

        # G8: cap the batch multiplier to avoid OOM on high rejection rates.
        # Without the cap, round 7 would request 3× still_need rows.
        _MAX_BATCH_MULTIPLIER = 2.0
        batch_size = int(still_need * min(1.0 + 0.25 * (round_idx + 1), _MAX_BATCH_MULTIPLIER))

        with logger.stage(f"round_{round_idx}_sample", input_rows=batch_size) as ctx_s:
            raw_batch = _fill_nan_numeric(engine.sample(batch_size))
            ctx_s.output_rows = len(raw_batch)

        with logger.stage(f"round_{round_idx}_validate", input_rows=len(raw_batch)) as ctx_v:
            result = vl.run(raw_batch, n_requested=n)
            output_warnings.extend(result.warnings)
            ctx_v.output_rows   = result.n_accepted
            ctx_v.rejected_rows = result.n_rejected_quality + result.n_rejected_duplicates
            ctx_v.reject_reasons = {
                "quality":    result.n_rejected_quality,
                "duplicates": result.n_rejected_duplicates,
            }
            ctx_v.metrics = {
                "acceptance_rate": round(
                    result.n_accepted / max(result.n_evaluated, 1), 4
                ),
                "rejection_rate": round(
                    1.0 - result.n_accepted / max(result.n_evaluated, 1), 4
                ),
            }

        # ── ENFORCEMENT: check output of validation before committing ──
        accept_df = result.clean_df.iloc[: max(still_need, 0)]
        if len(accept_df) > 0:
            # D2: enforce cross-column constraints on each accepted batch
            if _constraint_rules:
                try:
                    accept_df, _c_warns = enforce_constraints(
                        accept_df, _constraint_rules, rng,
                        stage=f"constraint_enforcer_round_{round_idx}",
                    )
                    output_warnings.extend(_c_warns)
                except PipelineHardFail:
                    raise  # propagate hard constraint violations
                except Exception as _ce:
                    output_warnings.append(
                        f"[ConstraintEnforcer] Round {round_idx}: skipped ({_ce})"
                    )
            enforcer.run_post_stage(
                stage         = f"round_{round_idx}_output",
                df            = accept_df,
                metrics       = ctx_v.metrics,
                allow_partial = True,
            )
            cp.commit(accept_df, round=round_idx, validation_result=result)

    # ════════════════════════════════════════════════════════════════
    # FINAL CHECKS
    # ════════════════════════════════════════════════════════════════
    final_n = cp.n_collected
    enforcer.record_rows(final_n)

    # Step B: warn if per-stratum categorical lookup fell back to unconditional
    # sampling for a significant fraction of rows — indicates a key-type mismatch
    # that wasn't caught by Step A normalization.
    _fallback_count = getattr(engine, "_cond_sample_fallback_count", 0)
    if _fallback_count > 0.05 * n:
        output_warnings.append(
            f"Per-stratum categorical lookup fell back to unconditional "
            f"sampling for {_fallback_count}/{n} rows — "
            f"check class_cat_stats key types/coverage."
        )

    # Partial row count is a HARD FAIL — the generation algorithm failed
    # to produce the requested number of clean rows.
    if final_n < n:
        raise PipelineHardFail(
            message = (
                f"GENERATION INCOMPLETE: Produced only {final_n}/{n} accepted rows "
                f"after {_MAX_QUALITY_ROUNDS} rounds. "
                "Possible causes: overly strict constraints, degenerate baseline, "
                "or excessive duplicate-rejection rate."
            ),
            stage   = "generate_row_count",
            context = {"final_n": final_n, "requested": n, "rounds": _MAX_QUALITY_ROUNDS},
        )

    cp.seal(status="complete", warnings=output_warnings)

    # ════════════════════════════════════════════════════════════════
    # FREEZE — atomic immutability lock
    # Called immediately after seal(), before ANY read.
    # After this point: commit() and reset() raise RuntimeError.
    # Guarantees: validated_data === returned_data
    # (no write can occur between cp.peek() and export_guarded())
    # ════════════════════════════════════════════════════════════════
    cp.freeze()

    # ════════════════════════════════════════════════════════════════
    # PIPELINE CONTRACT — gate 1: all per-round checks must have passed
    # ════════════════════════════════════════════════════════════════
    contract_result = enforcer.enforce_contract()

    # ════════════════════════════════════════════════════════════════
    # CONTENT HASH — capture SHA-256 of the frozen dataset
    # This hash will be re-verified after export_guarded() to assert
    # bit-identical consistency: validated_data === returned_data
    # ════════════════════════════════════════════════════════════════
    pre_validation_hash = cp.content_hash()

    # ════════════════════════════════════════════════════════════════
    # READ FOR VALIDATION — cp.peek() is only allowed after freeze()
    # Single source of truth: these are the EXACT rows that will be
    # returned. peek() raises RuntimeError if not frozen.
    # ════════════════════════════════════════════════════════════════
    validation_records = cp.peek()

    if len(validation_records) != final_n:
        raise StageError(
            stage   = "peek_size_check",
            message = (
                f"CheckPoint peek size mismatch: "
                f"committed={final_n}, peeked={len(validation_records)}"
            ),
        )

    # ════════════════════════════════════════════════════════════════
    # H05 — DIVERSITY GUARD (G2 fix: was never called before)
    # Run on the frozen validation_records before the evaluation gate
    # so distribution collapse is caught early with a clear error.
    # ════════════════════════════════════════════════════════════════
    _synth_for_diversity = pd.DataFrame(validation_records)
    check_diversity(_synth_for_diversity, stage="post_generation", bl=bl)

    # ════════════════════════════════════════════════════════════════
    # INDEPENDENT EVALUATION — gate 2 (hard)
    # Runs on frozen validation_records — exact same data as export.
    # verdict == "FAIL" or "ERROR" → PipelineHardFail (no bypass)
    # verdict == "WARN"            → informational only
    # ════════════════════════════════════════════════════════════════
    with logger.stage("evaluation", input_rows=len(validation_records)) as ctx_eval:
        evaluation = _eval_fn(
            synthetic_rows = validation_records,
            original_path  = dataset_path,
            baseline       = artifact,
        )
        ctx_eval.output_rows = len(validation_records)
        ctx_eval.metrics = {
            "verdict":        evaluation.get("verdict"),
            "duplicate_rate": evaluation.get("duplicate_rate"),
        }
        if evaluation.get("verdict") == "FAIL":
            errors = '; '.join(evaluation.get('errors', []))
            raise PipelineHardFail(
                message = f"EVALUATION GATE: Independent evaluation FAILED. {errors}",
                stage   = "evaluation",
                context = evaluation,
            )
        if evaluation.get("verdict") == "ERROR":
            raise PipelineHardFail(
                message = (
                    f"EVALUATION GATE: Evaluation raised an internal error: "
                    f"{evaluation.get('error', 'unknown')}"
                ),
                stage   = "evaluation",
                context = evaluation,
            )
        for w in evaluation.get("warnings", []):
            output_warnings.append(f"[Evaluation] {w}")

    # ════════════════════════════════════════════════════════════════
    # LEAKAGE GATE — gate 3 (hard)
    # Metrics derived from validation_records (the frozen dataset).
    # No intermediate or partial data is used.
    # ════════════════════════════════════════════════════════════════
    leakage_metrics = {
        "duplicates_rate": evaluation.get("duplicate_rate"),
    }
    with logger.stage("leakage_gate") as ctx_lg:
        enforce_leakage(leakage_metrics, stage="leakage_gate")
        ctx_lg.metrics = leakage_metrics
    leakage_passed = True

    # ════════════════════════════════════════════════════════════════
    # FINAL DECISION — gate 4 (single authority, before export)
    # If this raises, cp.export() is never called.
    # ════════════════════════════════════════════════════════════════
    from final_decision import final_decision as _final_decision
    _final_decision(
        contract_result   = contract_result,
        leakage_passed    = leakage_passed,
        evaluation_result = evaluation,
        stage             = "pre_export_final_decision",
    )

    # ════════════════════════════════════════════════════════════════
    # GUARDED EXPORT — gate 5 (authorized I/O, last operation)
    # cp.export() is called ONLY after ALL gates pass.
    # ════════════════════════════════════════════════════════════════
    records = export_guarded(cp, contract_result)

    if len(records) != final_n:
        raise StageError(
            stage   = "export_guarded",
            message = (
                f"CheckPoint export size mismatch after all gates: "
                f"committed={final_n}, exported={len(records)}"
            ),
        )

    # ════════════════════════════════════════════════════════════════
    # IDENTITY ASSERTION — validated_data === returned_data (mandatory)
    # Re-compute the SHA-256 of the exported rows and compare it to the
    # hash captured before validation. Any divergence is a hard crash.
    # ════════════════════════════════════════════════════════════════
    post_export_hash = cp.content_hash()
    if pre_validation_hash != post_export_hash:
        raise PipelineHardFail(
            message = (
                "DATA DIVERGENCE DETECTED: The dataset used for validation "
                "differs from the exported dataset. "
                f"pre_validation_hash={pre_validation_hash!r}, "
                f"post_export_hash={post_export_hash!r}. "
                "This indicates a forbidden mutation occurred between "
                "cp.freeze() and export_guarded()."
            ),
            stage   = "identity_assertion",
            context = {
                "pre_validation_hash": pre_validation_hash,
                "post_export_hash":    post_export_hash,
            },
        )

    # ════════════════════════════════════════════════════════════════
    # ORIGIN TAGGING — C05 feedback loop prevention
    # Tag every record with _origin="generated" so it can never be
    # silently reused as training input. check_origin_purity() at
    # training time will reject any tagged rows.
    # ════════════════════════════════════════════════════════════════
    records = tag_generated_rows(records)

    # ════════════════════════════════════════════════════════════════
    # CROSS-RUN DRIFT TRACKING — M03
    # Build a distribution snapshot and compare to previous run.
    # WARNING-level drift is logged. CRITICAL drift raises HardFail.
    # ════════════════════════════════════════════════════════════════
    try:
        import pandas as _pd_drift
        _cache_dir_drift = cache_dir or os.path.join(os.path.dirname(baseline_path), "cache")
        _drift_store = DriftStore(cache_dir=_cache_dir_drift, fingerprint=bl.fingerprint)
        _synth_df_for_drift = _pd_drift.DataFrame(
            [{k: v for k, v in r.items() if not k.startswith("_")} for r in records]
        )
        # Skip FREE_TEXT and HIGH_CARD_CATEGORICAL excluded columns: their values
        # are generated by random pool sampling each run, so top-frequency maps
        # are always disjoint across runs → guaranteed false critical drift.
        try:
            from preprocessing_layer import ColumnType as _ColType
            _drift_skip_cols = {
                col
                for col in manifest.excluded_cols
                if manifest.columns.get(col) is not None
                and manifest.columns[col].col_type in (
                    _ColType.FREE_TEXT,
                    _ColType.HIGH_CARD_CATEGORICAL,
                    _ColType.ID_COLUMN,   # IDs/emails are regenerated fresh each run → always max drift
                    _ColType.DATETIME,    # D1: uniformly sampled timestamps → high inter-run drift is expected
                )
            }
        except Exception:
            _drift_skip_cols = set()
        _snapshot = _drift_store.build_snapshot(
            _synth_df_for_drift, run_id=run_id, seed=resolved_seed,
            skip_cols=_drift_skip_cols,
        )
        _drift_report = _drift_store.compare_and_record(_snapshot, _synth_df_for_drift)
        if _drift_report.has_warning:
            output_warnings.append(
                f"[Drift] Cross-run drift detected: avg={_drift_report.avg_drift:.4f}, "
                f"max={_drift_report.max_drift:.4f}, "
                f"columns={', '.join(_drift_report.drifted_columns[:5])}"
            )
        logger.log(
            stage   = "drift_check",
            event   = "DRIFT_MEASURED",
            metrics = {
                "avg_drift":         _drift_report.avg_drift,
                "max_drift":         _drift_report.max_drift,
                "previous_run_id":   _drift_report.previous_run_id,
                "has_warning":       _drift_report.has_warning,
                "has_critical_drift": _drift_report.has_critical_drift,
            },
        )
    except PipelineHardFail:
        raise    # critical drift — hard fail propagates
    except Exception as _drift_exc:
        output_warnings.append(f"[Drift] Drift check skipped: {_drift_exc}")

    logger.log(
        stage       = "generate",
        event       = "SUCCESS",
        output_rows = len(records),
        metrics     = {
            "seed":                 resolved_seed,
            "engine":               actual_engine,
            "verdict":              evaluation.get("verdict"),
            "contract":             contract_result.clauses,
            "config_hash":          snap.config_hash,
            "content_hash":         post_export_hash,
        },
    )

    # ════════════════════════════════════════════════════════════════
    # SINGLE EXIT — the ONLY return in generate()
    # OutputController.release() calls final_decision() a second time
    # as belt-and-suspenders. No result escapes without it.
    # ════════════════════════════════════════════════════════════════
    return OutputController.release(
        pipeline_output = {
            "samples":                  records,
            "generator_used":           actual_engine,
            "engine_selection_reason":  _engine_reason,  # D3
            "row_count":                len(records),
            "dataset_fingerprint":      bl.fingerprint,
            "warnings":                 output_warnings,
            "checkpoint_path":          cp_path,
            "run_id":                   run_id,
            "seed":                     resolved_seed,
            "config_hash":              snap.config_hash,
            "content_hash":             post_export_hash,
            "contract":                 contract_result.to_dict(),
            "evaluation":               evaluation,
        },
        contract_result   = contract_result,
        leakage_passed    = leakage_passed,
        evaluation_result = evaluation,
    )



# Section 9 — Math / sampling helpers
#
# _build_quantile_cdf       : build piecewise-linear inverse CDF from spec
# _quantile_cdf_sample      : inverse-CDF sampling (no rejection, bounded)
# _nearest_pd               : nearest positive-definite matrix (Higham 1988)
# _to_standard_normal       : rank-based transform array → N(0,1)
# _resample_out_of_range    : replace OOB values using quantile CDF resample
# _apply_cholesky_correlations : Gaussian copula Cholesky correlation injection
# _load_original            : load original dataframe from disk
# _df_to_json_records       : DataFrame → JSON-safe list of dicts
# ==================================================================

def _build_quantile_cdf(
    spec: Dict[str, Any],
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    """
    Build a piecewise-linear inverse CDF from a numeric column spec.

    Uses all quantile statistics present in the spec:
        (0.00 → min)
        (0.01 → q01)   if available
        (0.05 → q05)   if available
        (0.25 → q25)   if available
        (0.50 → q50)   if available, else mean used as anchor
        (0.75 → q75)   if available
        (0.95 → q95)   if available
        (0.99 → q99)   if available
        (1.00 → max)

    The resulting (levels, values) arrays can be passed directly to
    np.interp(u, levels, values) for inverse-CDF sampling.

    Returns (None, None) when min or max are unavailable.

    Properties:
    • Naturally bounded: output ∈ [min, max] for any u ∈ [0, 1]
    • Distribution-shape-preserving: median, IQR, tails all matched
    • Works for symmetric, skewed, and heavy-tailed distributions
    • Monotone by construction (duplicate levels removed; non-monotone
      values floored to the previous value)
    """
    lo = spec.get("min")
    hi = spec.get("max")
    if lo is None or hi is None:
        return None, None

    lo, hi = float(lo), float(hi)
    if lo > hi:
        # Inverted bounds in baseline spec — swap to prevent monotonicity
        # enforcement from collapsing all CDF values to a single point.
        lo, hi = hi, lo

    # Ordered (probability_level, quantile_value) anchor pairs
    anchors: List[Tuple[float, float]] = [(0.0, lo), (1.0, hi)]

    for key, level in (
        ("q01", 0.01), ("q05", 0.05), ("q25", 0.25),
        ("q50", 0.50),
        ("q75", 0.75), ("q95", 0.95), ("q99", 0.99),
    ):
        val = spec.get(key)
        if val is not None:
            anchors.append((level, float(val)))

    # If q50 is absent, use mean as a central anchor
    has_q50 = any(abs(lv - 0.50) < 1e-9 for lv, _ in anchors)
    if not has_q50:
        mean_val = spec.get("mean")
        if mean_val is not None:
            anchors.append((0.50, float(mean_val)))

    # Sort by level; resolve duplicate levels (keep last — finer stats win)
    anchors.sort(key=lambda x: x[0])
    deduped: Dict[float, float] = {}
    for lv, val in anchors:
        deduped[lv] = val

    levels = np.array(sorted(deduped.keys()), dtype=float)
    values = np.array([deduped[l] for l in levels], dtype=float)

    # Enforce monotonicity: CDF values must be non-decreasing
    for i in range(1, len(values)):
        if values[i] < values[i - 1]:
            values[i] = values[i - 1]

    return levels, values


def _quantile_cdf_sample(
    n:      int,
    levels: np.ndarray,
    values: np.ndarray,
    rng:    np.random.Generator,
) -> np.ndarray:
    """
    Draw n samples from the distribution defined by the piecewise-linear
    inverse CDF (levels, values) by sampling U ~ Uniform(0, 1) and
    applying np.interp.

    Properties:
    • 100% acceptance rate — no rejection loop
    • Output is naturally bounded within [values[0], values[-1]]
    • Preserves the full distribution shape encoded in the quantile points

    FIX-13: adds small uniform jitter proportional to the local segment
    width. With only ~9 quantile knots (min, q01, q05, q25, q50, q75, q95,
    q99, max), the piecewise-linear interpolation alone produces a visible
    "staircase" -- values cluster at knot points. The jitter is scaled to
    10% of the local segment width so it never pushes a value into a
    neighboring segment's density regime, and the result is clipped back
    into [values[0], values[-1]] to preserve the bounded-output guarantee.
    """
    u = rng.uniform(0.0, 1.0, size=n)
    raw = np.interp(u, levels, values)
    if len(values) < 2:
        # Degenerate case (e.g. an all-identical-value column): no segments
        # to jitter within, and jittering would divide by an empty diff.
        return raw
    seg_indices = np.clip(np.searchsorted(levels, u) - 1, 0, len(levels) - 2)
    seg_widths = np.diff(values)
    jitter = rng.uniform(-0.5, 0.5, size=n) * seg_widths[seg_indices] * 0.1
    return np.clip(raw + jitter, values[0], values[-1])

def _resample_out_of_range(
    arr:  np.ndarray,
    lo:   float,
    hi:   float,
    spec: Dict[str, Any],
    rng:  np.random.Generator,
    max_attempts: int = 10,
) -> np.ndarray:
    """
    Replace values outside [lo, hi] by resampling from the quantile CDF of
    the column's marginal distribution (defined by spec).

    Uses quantile-CDF sampling rather than Gaussian resampling so that the
    distribution shape — including skew and tail weight — is respected.
    This is the replacement for np.clip: boundary values appear only at
    their natural frequency rather than being artificially concentrated.

    Last-resort clamp (applied to any value still out-of-range after
    max_attempts) is deliberately kept so the method always terminates;
    for well-specified columns this path should never fire.
    """
    if lo > hi:
        lo, hi = hi, lo  # Inverted bounds → swap; prevents collapse to one boundary
    out_mask = (arr < lo) | (arr > hi)
    if not out_mask.any():
        return arr

    arr    = arr.copy()
    levels, values = _build_quantile_cdf(spec)

    for _ in range(max_attempts):
        still_out = np.where(out_mask)[0]
        if len(still_out) == 0:
            break
        if levels is not None:
            fresh = _quantile_cdf_sample(len(still_out), levels, values, rng)
        else:
            mean  = float(spec.get("mean", (lo + hi) / 2))
            std_v = float(spec.get("std",  (hi - lo) / 4)) or 1e-6
            fresh = rng.normal(mean, std_v, size=len(still_out))
        arr[still_out]      = fresh
        out_mask[still_out] = (fresh < lo) | (fresh > hi)

    # Last resort: clamp any remaining stragglers
    remaining = np.where(out_mask)[0]
    if len(remaining) > 0:
        arr[remaining] = np.where(arr[remaining] < lo, lo, hi)
    return arr


def _apply_cholesky_correlations(
    data: Dict[str, np.ndarray],
    bl:   "BaselineReader",
    rng:  np.random.Generator,
    n:    int,
) -> Dict[str, np.ndarray]:
    """
    Inject Pearson-based covariance into numeric columns via a Gaussian copula
    Cholesky decomposition.  Preserves each column's marginal distribution
    exactly while introducing the target inter-column correlations.

    Algorithm (correct copula round-trip):
      1. Map each column to U[0,1] via rank-based empirical CDF transform.
      2. Apply probit (Φ⁻¹) to map U → Z ~ N(0,1).
      3. Multiply by Cholesky factor L of the target correlation matrix
         so that Cov(Z_corr) ≈ target_corr.
      4. Apply standard normal CDF Φ to map Z_corr back to U_corr ∈ (0,1).
      5. Apply inverse quantile CDF (Q⁻¹) of each column's marginal to
         map U_corr → values in the original data space.

    Step 5 uses the piecewise-linear quantile CDF built from the baseline
    spec, which preserves skew, tails, and IQR rather than assuming Gaussian
    marginals.  Out-of-range values are resolved by resample-retry.
    """
    try:
        from scipy.special import ndtr as _ndtr   # standard normal CDF Φ
    except ImportError:
        _ndtr = None  # fallback defined below

    pairs = bl.strong_pearson_pairs(threshold=0.4)
    if not pairs:
        return data

    involved: List[str] = []
    for a, b, _ in pairs:
        if a not in involved and a in data:
            involved.append(a)
        if b not in involved and b in data:
            involved.append(b)

    if len(involved) < 2:
        return data

    k       = len(involved)
    corr    = np.eye(k)
    col_idx = {c: i for i, c in enumerate(involved)}

    for a, b, v in pairs:
        if a in col_idx and b in col_idx:
            i, j       = col_idx[a], col_idx[b]
            corr[i, j] = v
            corr[j, i] = v

    corr = _nearest_pd(corr)

    try:
        L = np.linalg.cholesky(corr)
    except np.linalg.LinAlgError:
        return data  # bail gracefully

    # Step 1–3: rank → Z → Cholesky-correlated Z_corr
    Z      = np.column_stack([_to_standard_normal(data[c], rng) for c in involved])
    Z_corr = Z @ L.T

    # Step 4: Z_corr → U_corr via Φ
    if _ndtr is not None:
        U_corr = _ndtr(Z_corr)
    else:
        # Pure numpy fallback: Φ(z) = 0.5 * erfc(-z / sqrt(2))
        U_corr = 0.5 * np.erfc(-Z_corr / np.sqrt(2.0))

    # Clip strictly inside (0,1) so Q⁻¹ interpolation never extrapolates
    U_corr = np.clip(U_corr, 1e-7, 1.0 - 1e-7)

    # Step 5: U_corr → original data space via per-column inverse quantile CDF
    for i, col in enumerate(involved):
        spec          = bl.numeric[col]
        lo            = float(spec.get("min", -np.inf))
        hi            = float(spec.get("max",  np.inf))
        levels, values = _build_quantile_cdf(spec)

        if levels is not None:
            raw = np.interp(U_corr[:, i], levels, values)
        else:
            # Degenerate spec — Gaussian fallback
            mean = float(spec.get("mean", 0.0))
            std  = float(spec.get("std",  1.0)) or 1.0
            raw  = Z_corr[:, i] * std + mean

        data[col] = _resample_out_of_range(raw, lo, hi, spec, rng)

    return data

def _nearest_pd(A: np.ndarray) -> np.ndarray:
    """
    Find the nearest positive-definite matrix to A.
    Uses the Higham (1988) algorithm via eigenvalue flooring.
    Ensures Cholesky decomposition never fails due to numerical noise.
    """
    B    = (A + A.T) / 2
    eigvals, eigvecs = np.linalg.eigh(B)
    eigvals = np.maximum(eigvals, 1e-8)
    return eigvecs @ np.diag(eigvals) @ eigvecs.T


def _to_standard_normal(arr: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """
    Rank-based transform: map arr to approximately N(0,1).
    Used by StatisticalEngine's Cholesky step.
    Ties are broken with a small random perturbation to avoid flat regions.
    """
    n      = len(arr)
    noise  = rng.random(n) * 1e-10
    ranks  = np.argsort(np.argsort(arr.astype(float) + noise))
    # Map ranks to (0,1) then apply probit
    u      = (ranks + 0.5) / n
    u      = np.clip(u, 1e-6, 1.0 - 1e-6)
    # Probit via erfcinv: z = sqrt(2) * erfcinv(2 * (1 - u))
    return np.sqrt(2.0) * _erfcinv(2.0 * (1.0 - u))


def _erfcinv(y: np.ndarray) -> np.ndarray:
    """
    Inverse complementary error function — pure numpy implementation.
    erfcinv(y) = erfinv(1 - y).

    Uses the Abramowitz & Stegun rational approximation split into
    two polynomial branches.  Accurate to ~6 significant figures.
    No scipy dependency — used by _to_standard_normal in the
    StatisticalEngine path.
    """
    x = np.clip(1.0 - y, -1.0 + 1e-9, 1.0 - 1e-9)
    w = -np.log((1.0 - x) * (1.0 + x))

    # Branch 1 coefficients (w < 5, central region)
    w1   = w - 2.5
    c1_0 = 2.81022636e-08
    c1_1 = 3.43273939e-07
    c1_2 = -3.52338770e-06
    c1_3 = -4.39150654e-06
    c1_4 = 2.18580870e-04
    c1_5 = -1.25372503e-03
    c1_6 = -4.17768164e-03
    c1_7 = 2.46640727e-01
    c1_8 = 1.50140941e+00
    p1 = c1_8 + w1 * (c1_7 + w1 * (c1_6 + w1 * (c1_5 + w1 * (
         c1_4 + w1 * (c1_3 + w1 * (c1_2 + w1 * (c1_1 + w1 * c1_0)))))))

    # Branch 2 coefficients (w >= 5, tail region)
    w2   = np.sqrt(np.maximum(w, 0.0)) - 3.0
    c2_0 = -2.00214257e-04
    c2_1 = 1.00950558e-04
    c2_2 = 1.34934322e-03
    c2_3 = -3.67342844e-03
    c2_4 = 5.73950773e-03
    c2_5 = -7.62246130e-03
    c2_6 = 9.43887047e-03
    c2_7 = 1.00167406e+00
    c2_8 = 2.83297682e+00
    p2 = c2_8 + w2 * (c2_7 + w2 * (c2_6 + w2 * (c2_5 + w2 * (
         c2_4 + w2 * (c2_3 + w2 * (c2_2 + w2 * (c2_1 + w2 * c2_0)))))))

    p = np.where(w < 5.0, p1, p2)
    return p * x


def _sanitize_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    if df is None:
        return df
    # ISSUE 19 fix: copy before mutating to avoid modifying the caller's
    # DataFrame when it holds a reference to the same object.
    needs_copy = True
    for col in df.columns:
        if df[col].dtype == object or df[col].dtype == 'O':
            has_unhashable = df[col].dropna().apply(lambda x: isinstance(x, (list, dict, set))).any()
            if has_unhashable:
                if needs_copy:
                    df = df.copy()
                    needs_copy = False
                df[col] = df[col].apply(lambda x: json.dumps(x, ensure_ascii=False) if isinstance(x, (list, dict, set)) else x)
    return df


def _load_original(dataset_path: str, bl: BaselineReader) -> pd.DataFrame:
    """Load the original dataset from disk using the kind stored in the baseline."""
    kind = bl.source  # source = file path; we infer kind from extension
    ext  = os.path.splitext(dataset_path)[1].lower()

    if ext == ".csv":
        df = pd.read_csv(dataset_path)
    elif ext == ".tsv":  # G1: TSV requires tab separator
        df = pd.read_csv(dataset_path, sep='\t')
    elif ext in (".xlsx", ".xlsm"):
        df = pd.read_excel(dataset_path)
    elif ext in (".json", ".jsonl"):
        try:
            df = pd.read_json(dataset_path)
        except Exception:
            df = pd.read_json(dataset_path, lines=True)
    elif ext == ".parquet":
        df = pd.read_parquet(dataset_path)
    else:
        raise ValueError(f"Unsupported format: '{ext}'")

    return _sanitize_dataframe(df)



# ==================================================================
# Section 10 — CLI entry point
# Matches the invocation pattern used by extension.ts (cp.spawn).
# Writes one JSON object to stdout on success.
# Writes error JSON to stderr and exits with code 1 on failure.
# ==================================================================

def _main(argv: Optional[List[str]] = None) -> int:
    # Force stdout/stderr to UTF-8 on Windows
    import sys as _sys
    if hasattr(_sys.stdout, "reconfigure"):
        _sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(_sys.stderr, "reconfigure"):
        _sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    p = argparse.ArgumentParser(
        description="generator.py — Synthetic Data Generation Engine"
    )
    p.add_argument("dataset_path",  help="Path to the original dataset file.")
    p.add_argument("baseline_path", help="Path to the BaselineArtifact JSON file.")
    p.add_argument("--n",           type=int, default=None,
                   help="Number of synthetic rows to generate.")
    p.add_argument("--cache-dir",   default=None,
                   help="Directory for model cache files.")
    p.add_argument("--seed",        type=int, default=None,
                   help="Random seed for reproducibility.")
    p.add_argument("--engine",
                   choices=["auto", "statistical", "probabilistic", "ctgan"],
                   default="auto",
                   help="Force a specific engine (default: auto, selected by dataset size).")
    args = p.parse_args(argv)

    # Resolve n: CLI arg > policy default_n > hard error
    n_requested = args.n
    if n_requested is None:
        _pol = _load_synthetic_policy(args.dataset_path)
        _default_n = _pol.get("default_n")
        if _default_n is not None:
            try:
                n_requested = int(_default_n)
            except (TypeError, ValueError):
                pass
    if n_requested is None:
        p.error("--n is required unless default_n is set in policy.yaml synthetic_data section")

    # Suppress noisy third-party warnings (pandas FutureWarning etc.)
    # so they don't pollute stdout and break JSON parsing in the extension.
    _warnings_mod.filterwarnings("ignore")

    try:
        result = generate(
            dataset_path    = args.dataset_path,
            baseline_path   = args.baseline_path,
            n               = n_requested,
            cache_dir       = args.cache_dir,
            seed            = args.seed,
            engine_override = args.engine if args.engine != "auto" else None,
        )
        _sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 0

    except PipelineHardFail as hf:
        # Exit code 2 = enforcement failure (structured, actionable)
        _sys.stderr.write(json.dumps(hf.to_dict(), ensure_ascii=False) + "\n")
        return 2
    except Exception as exc:
        err = {"error": str(exc), "type": type(exc).__name__, "stage": "unknown"}
        _sys.stderr.write(json.dumps(err, ensure_ascii=False) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(_main())