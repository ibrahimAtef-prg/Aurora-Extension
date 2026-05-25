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
from diversity_guard       import tag_generated_rows            # noqa: E402
from drift_store           import DriftStore                    # noqa: E402
from preprocessing_layer   import (                              # noqa: E402
    build_manifest, apply_manifest, merge_outputs,
    PreprocessingManifest, ColumnMergeError,
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
        # Label column detection (dataset-agnostic heuristic)
        # A categorical column is treated as the label/target when it is
        # low-cardinality (2–50 classes) AND has the highest total absolute
        # point-biserial association with numeric columns.  This matches the
        # typical "target column correlates with many features" pattern without
        # relying on any domain-specific column name.
        # ------------------------------------------------------------------
        self.label_col: Optional[str] = self._detect_label_col()

        # Per-class statistics populated lazily by build_class_stats().
        # Structure: col → label_value → {"mean": float, "std": float,
        #                                  "min": float, "max": float,
        #                                  "q25": float, "q75": float}
        self.class_numeric_stats: Dict[str, Dict[str, Dict[str, float]]] = {}
        # Structure: cat_col → label_value → {value: prob}
        self.class_cat_stats: Dict[str, Dict[str, Dict[str, float]]] = {}
        # Marginal label distribution {label_value: probability}
        self.label_dist: Dict[str, float] = {}
        if self.label_col and self.label_col in self.categorical:
            ratios = self.categorical[self.label_col].get("top_value_ratios") or {}
            total  = sum(ratios.values()) or 1.0
            self.label_dist = {k: v / total for k, v in ratios.items()}
        # Per-class covariance matrices populated by build_class_stats()
        # col_group → label_value → (mean_vec, cov_matrix, col_names)
        self.class_covariance: Dict[str, Tuple[np.ndarray, np.ndarray, List[str]]] = {}

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

    def _detect_label_col(self) -> Optional[str]:
        """
        Heuristically identify a label/target column from the baseline.

        Criteria (all must pass):
        1. Column is categorical with 2–50 unique values.
        2. Column appears in at least one point-biserial entry as the
           cat side (i.e. it correlates with at least one numeric feature).
        3. Among all qualifying columns, the one with the highest *sum* of
           absolute point-biserial correlations across all numeric partners
           is selected.  This mirrors the intuition that a target variable
           tends to correlate broadly with features.

        Returns None if no suitable column is found (unlabelled dataset).
        """
        _MIN_CLASSES = 2
        _MAX_CLASSES = 50

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

        if not qualifying:
            return None

        # Reject columns whose top_value_ratios keys are all numeric-like strings
        filtered: List[str] = []
        for col in qualifying:
            spec   = self.categorical[col]
            ratios = spec.get("top_value_ratios") or {}
            vals   = list(ratios.keys())
            if vals and all(_NUMERIC_STR.match(str(v)) for v in vals):
                continue  # skip — looks like a numeric-coded column, not a label
            filtered.append(col)
        qualifying = filtered

        if not qualifying:
            return None

        # Score each qualifying column by total abs point-biserial
        scores: Dict[str, float] = {col: 0.0 for col in qualifying}
        for key, v in self.pb.items():
            cat_col = key.split("__", 1)[0]
            if cat_col in scores:
                scores[cat_col] += abs(v)

        # Must have at least one numeric correlation to qualify
        candidates = {col: s for col, s in scores.items() if s > 0.0}
        if not candidates:
            return None

        return max(candidates, key=lambda c: candidates[c])

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

        Safe to call multiple times; results are overwritten.
        Requires pandas to be imported (guaranteed by the engine that calls it).
        """
        import pandas as _pd  # local import to avoid top-level hard dep

        if not self.label_col or self.label_col not in df.columns:
            return

        label_series = df[self.label_col].astype(str)
        label_values = label_series.unique().tolist()

        num_cols = [c for c in self.numeric if c in df.columns]
        cat_cols = [c for c in self.categorical
                    if c in df.columns and c != self.label_col]

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
                entry[lv] = {
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

            # Categorical per-class stats
            for col in cat_cols:
                s  = sub[col].dropna().astype(str)
                vc = s.value_counts(normalize=True)
                if len(vc) == 0:
                    continue
                entry = self.class_cat_stats.setdefault(col, {})
                entry[lv] = vc.to_dict()

        # Per-class covariance matrices for all numeric columns together
        if len(num_cols) >= 2:
            for lv in label_values:
                mask  = label_series == lv
                sub   = df[mask][num_cols].apply(_pd.to_numeric, errors="coerce").dropna()
                if len(sub) < len(num_cols) + 1:
                    continue
                mu  = sub.mean().values
                cov = sub.cov().values
                cov = _nearest_pd(cov)
                self.class_covariance[lv] = (mu, cov, num_cols)


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

            # 2. Sample numeric features conditioned on label
            for col, spec in bl.numeric.items():
                arr = np.empty(n, dtype=float)
                for lv in label_choices:
                    mask   = labels == lv
                    n_lv   = int(mask.sum())
                    if n_lv == 0:
                        continue
                    cls_stats = bl.class_numeric_stats.get(col, {}).get(lv)
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
                arr = np.empty(n, dtype=object)
                for lv in label_choices:
                    mask = labels == lv
                    n_lv = int(mask.sum())
                    if n_lv == 0:
                        continue
                    cls_freq = bl.class_cat_stats.get(col, {}).get(lv)
                    if cls_freq:
                        choices = list(cls_freq.keys())
                        wts     = np.array(list(cls_freq.values()), dtype=float)
                        wts     = wts / wts.sum()
                        arr[mask] = np.array(choices, dtype=object)[
                            rng.choice(len(choices), size=n_lv, p=wts)
                        ]
                    else:
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

        # Apply null masks
        for col in bl.col_order:
            nr = bl.null_ratio(col)
            if nr > 0.0 and col in data:
                null_mask = rng.random(n) < nr
                arr = data[col].astype(object)
                arr[null_mask] = None
                data[col] = arr

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
        Uses top_value_ratios from the baseline.
        """
        rng    = self.rng
        ratios = spec.get("top_value_ratios") or {}

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
        if len(num_cols_present) < 2:
            return data

        for lv in label_values:
            mask = np.where(labels == lv)[0]
            n_lv = len(mask)
            if n_lv < 2:
                continue

            # Use per-class covariance if available, else global Pearson-based
            if lv in bl.class_covariance:
                mu, cov, col_names = bl.class_covariance[lv]
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
        self._enc_cdfs    : Dict[str, Tuple]            = {}   # encoded-cat col → (sorted_vals, uniform_quantiles)
        self._cat_tables  : Dict[str, Dict]             = {}   # col → {bin_label → {value: prob}}
        self._num_cols    : List[str]                   = []

        # Per-class copula parameters (populated when label_col is detected)
        # label_value → {"mu": ndarray, "cov": ndarray, "cdfs": dict, "num_cols": list}
        self._class_copulas: Dict[str, Dict[str, Any]] = {}

        self._fitted      : bool                        = False

        # Preprocessing manifest integration
        self._manifest : Optional["PreprocessingManifest"] = manifest
        self._df_orig  : Optional[pd.DataFrame]            = None  # set by fit()

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def fit(self, df: pd.DataFrame) -> None:
        """Fit the Gaussian copula (global + per-class) on df."""
        bl = self.bl

        # Build per-class stats on the ORIGINAL df (not copula_df)
        # so class stats use real category values for label-first path.
        bl.build_class_stats(df)

        # ── If manifest available: fit copula on copula_df ────────────
        if self._manifest is not None:
            self._df_orig = df  # store for apply_manifest calls in sample()
            copula_df, _ = apply_manifest(
                self._manifest, df, len(df), self.rng
            )
            self._num_cols = list(copula_df.columns)

            # Encoded categorical columns (mean-encoded floats with very few unique values)
            # corrupt the Gaussian copula covariance matrix — their Z-scores cluster into
            # K discrete values (one per category), making the covariance near-singular.
            # Sample them independently from their marginal CDFs instead.
            if self._manifest.encoder is not None:
                enc_col_set = set(self._manifest.encoder.columns_in_copula)
                self._enc_cdfs = {}
                for col in list(self._num_cols):
                    if col in enc_col_set:
                        s = pd.to_numeric(copula_df[col], errors="coerce").dropna().sort_values()
                        if len(s) >= 2:
                            self._enc_cdfs[col] = (s.values, np.linspace(0.0, 1.0, len(s)))
                self._num_cols = [c for c in self._num_cols if c not in enc_col_set]
                copula_df = copula_df[self._num_cols] if self._num_cols else copula_df.iloc[:, :0]
        else:
            copula_df = df
            self._num_cols = [c for c in bl.numeric if c in df.columns]

        # ---- Global copula ----
        if self._num_cols:
            self._build_copula_from_df(copula_df, self._num_cols)

        # Remove any columns that failed copula/CDF construction.
        # Prevents stale latent dimensions from surviving in _num_cols.
        self._num_cols = [c for c in self._num_cols if c in self._cdfs]

        # ---- Per-class copulas (when label column detected) ----
        if bl.label_col and bl.label_col in df.columns and self._num_cols:
            label_series = df[bl.label_col].astype(str)
            for lv in label_series.unique():
                sub_copula = copula_df.loc[label_series[label_series == lv].index]
                if len(sub_copula) < len(self._num_cols) + 2:
                    continue  # too few rows for reliable copula
                mu, cov, cdfs = self._fit_copula_params(sub_copula, self._num_cols)
                if mu is not None:
                    self._class_copulas[lv] = {
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
        # Clamp strictly inside (0,1) for the probit transform — this is a
        # mathematical requirement of ndtri, not a data boundary clamp
        U = np.clip(U, 1e-6, 1.0 - 1e-6)
        Z = ndtri(U)

        mu  = Z.mean(axis=0)
        cov = np.cov(Z, rowvar=False) if Z.shape[1] > 1 else np.array([[1.0]])
        cov = _nearest_pd(cov)
        return mu, cov, cdfs

    def sample(self, n: int) -> pd.DataFrame:
        if not self._fitted:
            raise RuntimeError("ProbabilisticEngine.fit() must be called before sample().")

        bl  = self.bl
        rng = self.rng

        data: Dict[str, np.ndarray] = {}

        if bl.label_col and bl.label_dist and self._class_copulas:
            # ---- Label-first path ----
            label_choices = list(bl.label_dist.keys())
            label_probs   = np.array(list(bl.label_dist.values()), dtype=float)
            label_probs   = label_probs / label_probs.sum()
            labels        = np.array(label_choices, dtype=object)[
                rng.choice(len(label_choices), size=n, p=label_probs)
            ]
            data[bl.label_col] = labels

            # Initialise numeric arrays
            for col in self._num_cols:
                data[col] = np.empty(n, dtype=float)

            for lv in label_choices:
                mask = np.where(labels == lv)[0]
                n_lv = len(mask)
                if n_lv == 0:
                    continue

                copula = self._class_copulas.get(lv)
                if copula is None:
                    # Fall back to global copula for unseen / rare labels
                    copula = {
                        "mu": self._mu, "cov": self._cov,
                        "cdfs": self._cdfs, "num_cols": self._num_cols,
                    }

                mu_lv  = copula["mu"]
                cov_lv = copula["cov"]
                cdfs_lv = copula["cdfs"]
                cols_lv = copula["num_cols"]

                if mu_lv is None:
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

            # Sample categorical features conditioned on label
            for col, spec in bl.categorical.items():
                if col == bl.label_col:
                    continue
                arr = np.empty(n, dtype=object)
                for lv in label_choices:
                    mask = np.where(labels == lv)[0]
                    n_lv = len(mask)
                    if n_lv == 0:
                        continue
                    cls_freq = bl.class_cat_stats.get(col, {}).get(lv)
                    if cls_freq:
                        ch  = list(cls_freq.keys())
                        wts = np.array(list(cls_freq.values()), dtype=float)
                        wts = wts / wts.sum()
                        arr[mask] = np.array(ch, dtype=object)[
                            rng.choice(len(ch), size=n_lv, p=wts)
                        ]
                    else:
                        arr[mask] = self._sample_categorical_conditioned(
                            col, spec, data, n_lv
                        )
                data[col] = arr

            # Other columns (must be populated before null mask loop)
            for col in bl.other:
                data[col] = np.array([None] * n, dtype=object)

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
            # Fill encoded categorical columns from their marginal CDFs independently.
            # These were excluded from the Gaussian copula to prevent covariance corruption.
            for col, (vals, quant) in self._enc_cdfs.items():
                u = self.rng.uniform(0.0, 1.0, size=n)
                data[col] = np.interp(u, quant, vals)

            copula_output = pd.DataFrame(
                {col: data[col] for col in list(self._num_cols) + list(self._enc_cdfs) if col in data}
            )
            _, excluded_df = apply_manifest(
                self._manifest, self._df_orig, n, self.rng
            )
            # ColumnMergeError propagates — not caught
            return merge_outputs(
                copula_output, excluded_df, self._manifest, self.rng
            )

        # ── Legacy path (no manifest) ─────────────────────────────────
        # Null masks
        for col in bl.col_order:
            nr = bl.null_ratio(col)
            if nr > 0.0 and col in data:
                null_mask = rng.random(n) < nr
                arr = data[col].astype(object)
                arr[null_mask] = None
                data[col] = arr

        return pd.DataFrame({col: data[col] for col in bl.col_order if col in data})

    # ------------------------------------------------------------------
    # Cache helpers
    # ------------------------------------------------------------------

    def cache_path(self) -> Optional[str]:
        if not self.cache_dir or not self.bl.fingerprint:
            return None
        return os.path.join(self.cache_dir, f"{self.bl.fingerprint}_probabilistic.pkl")

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
            manifest_sig = hashlib.md5(
                str(sorted(self._manifest.copula_cols + _enc_cols)).encode()
            ).hexdigest()[:8]

        payload = {
            "mu":                  self._mu,
            "cov":                 self._cov,
            "cdfs":                self._cdfs,
            "enc_cdfs":            self._enc_cdfs,
            "cat_tables":          self._cat_tables,
            "num_cols":            self._num_cols,
            "class_copulas":       self._class_copulas,
            "label_col":           self.bl.label_col,
            "label_dist":          self.bl.label_dist,
            "class_cat_stats":     self.bl.class_cat_stats,
            "class_numeric_stats": self.bl.class_numeric_stats,
            "manifest_col_hash":   manifest_sig,
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
                current_sig = hashlib.md5(
                    str(sorted(self._manifest.copula_cols + _enc_cols)).encode()
                ).hexdigest()[:8]
            if cached_sig != current_sig:
                return False  # manifest changed — retrain

            self._mu            = payload["mu"]
            self._cov           = payload["cov"]
            self._cdfs          = payload["cdfs"]
            self._enc_cdfs      = payload.get("enc_cdfs", {})
            self._cat_tables    = payload["cat_tables"]
            self._num_cols      = payload["num_cols"]
            self._class_copulas = payload.get("class_copulas", {})
            if payload.get("label_col"):
                self.bl.label_col           = payload["label_col"]
                self.bl.label_dist          = payload.get("label_dist", {})
                self.bl.class_cat_stats     = payload.get("class_cat_stats", {})
                self.bl.class_numeric_stats = payload.get("class_numeric_stats", {})
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
                    bins       = pd.qcut(num_series, q=4, labels=False, duplicates="drop")
                    table: Dict[str, Dict[str, float]] = {}
                    for bin_label in bins.dropna().unique():
                        mask    = bins == bin_label
                        sub     = cat_series[mask]
                        vc      = sub.value_counts(normalize=True)
                        table[str(int(bin_label))] = vc.to_dict()
                    tables[col] = {"type": "conditional", "partner": num_col, "bins": table}
                    continue

            # Unconditional frequency table
            ratios = spec.get("top_value_ratios") or {}
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
        """
        rng   = self.rng
        table = self._cat_tables.get(col)

        if table is None or table["type"] == "unconditional":
            ratios  = spec.get("top_value_ratios") or {}
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
            ratios  = spec.get("top_value_ratios") or {}
            choices = list(ratios.keys()) if ratios else [None]
            weights = np.array(list(ratios.values()), dtype=float) if ratios else np.array([1.0])
            weights = weights / weights.sum()
            return np.array(choices, dtype=object)[rng.choice(len(choices), size=n, p=weights)]

        # Determine which quartile each generated numeric value falls into
        partner_spec = self.bl.numeric.get(partner, {})
        lo  = float(partner_spec.get("min", partner_arr.min()))
        hi  = float(partner_spec.get("max", partner_arr.max()))
        rng_span = hi - lo if hi > lo else 1.0
        result   = np.empty(n, dtype=object)

        bin_keys  = sorted(bins_table.keys(), key=lambda x: int(x))
        n_bins    = len(bin_keys)

        for idx in range(n):
            v       = float(partner_arr[idx]) if partner_arr[idx] is not None else lo
            bin_i   = min(int((v - lo) / rng_span * n_bins), n_bins - 1)
            bin_key = bin_keys[bin_i]
            freq    = bins_table[bin_key]
            if freq:
                ch  = list(freq.keys())
                wt  = np.array(list(freq.values()), dtype=float)
                wt  = wt / wt.sum()
                result[idx] = ch[rng.choice(len(ch), p=wt)]
            else:
                result[idx] = None

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
            self._fitted = True
            return

        # ── Manifest path: fit CTGAN on copula_df ─────────────────────
        if self._manifest is not None:
            self._df_orig = df
            _fit_rng = np.random.default_rng(42)  # deterministic fit rng
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
            dataset_path  = dataset_path,
            baseline_path = baseline_path,
            n             = n,
            cache_dir     = cache_dir,
            seed          = seed,
            output_warnings = output_warnings,
        )


def _generate_inner(
    dataset_path:    str,
    baseline_path:   str,
    n:               int,
    cache_dir:       Optional[str],
    seed:            Optional[int],
    output_warnings: List[str],
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
    if row_count < _SMALL_THRESHOLD:
        engine_name = StatisticalEngine.ENGINE_NAME
    elif row_count < _LARGE_THRESHOLD:
        engine_name = ProbabilisticEngine.ENGINE_NAME
    else:
        engine_name = CTGANEngine.ENGINE_NAME

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
    # ════════════════════════════════════════════════════════════════
    manifest = build_manifest(df_orig, artifact, overrides=synthetic_policy)
    if manifest.warnings:
        for _w in manifest.warnings:
            output_warnings.append(f"[preprocessing] {_w}")

    # ════════════════════════════════════════════════════════════════
    # Build and train engine
    # ════════════════════════════════════════════════════════════════
    with logger.stage("engine_build") as ctx_eng:
        if engine_name == StatisticalEngine.ENGINE_NAME:
            engine = StatisticalEngine(bl, _seed_mgr.spawn(root_rng, "statistical"))
            if bl.label_col:
                try:
                    bl.build_class_stats(df_orig)
                    output_warnings.append(
                        f"Label column detected (\'{bl.label_col}\'): "
                        "class-conditional statistics built for label-first generation."
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
            else:
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

    for round_idx in range(_MAX_QUALITY_ROUNDS):
        still_need = n - cp.n_collected
        if still_need <= 0:
            break

        batch_size = int(still_need * (1.0 + 0.25 * (round_idx + 1)))

        with logger.stage(f"round_{round_idx}_sample", input_rows=batch_size) as ctx_s:
            raw_batch = engine.sample(batch_size)
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
            "samples":             records,
            "generator_used":      actual_engine,
            "row_count":           len(records),
            "dataset_fingerprint": bl.fingerprint,
            "warnings":            output_warnings,
            "checkpoint_path":     cp_path,
            "run_id":              run_id,
            "seed":                resolved_seed,
            "config_hash":         snap.config_hash,
            "content_hash":        post_export_hash,
            "contract":            contract_result.to_dict(),
            "evaluation":          evaluation,
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
    """
    u = rng.uniform(0.0, 1.0, size=n)
    return np.interp(u, levels, values)

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


def _load_original(dataset_path: str, bl: BaselineReader) -> pd.DataFrame:
    """Load the original dataset from disk using the kind stored in the baseline."""
    kind = bl.source  # source = file path; we infer kind from extension
    ext  = os.path.splitext(dataset_path)[1].lower()

    if ext in (".csv", ".tsv"):
        return pd.read_csv(dataset_path)
    if ext in (".xlsx", ".xlsm"):
        return pd.read_excel(dataset_path)
    if ext == ".json":
        try:
            return pd.read_json(dataset_path)
        except Exception:
            return pd.read_json(dataset_path, lines=True)
    if ext == ".parquet":
        return pd.read_parquet(dataset_path)

    raise ValueError(f"Unsupported format: '{ext}'")



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
            dataset_path  = args.dataset_path,
            baseline_path = args.baseline_path,
            n             = n_requested,
            cache_dir     = args.cache_dir,
            seed          = args.seed,
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