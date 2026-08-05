"""
preprocessing_layer.py — Column-Type Gatekeeper for AutoMate Aurora
====================================================================

Pipeline position:
    parse.py → baseline.py → **preprocessing_layer.py** → generator.py

Purpose
-------
Classify every column into a rich 6-type taxonomy and produce a
PreprocessingManifest that generator.py consumes.  Only columns that
are mathematically valid for copula / CTGAN enter those engines; all
others are pre-generated here using type-appropriate strategies.

Public API
----------
    build_manifest(df, baseline)      → PreprocessingManifest
    apply_manifest(manifest, df, n, rng) → (copula_df, excluded_df)
    merge_outputs(copula_output, excluded_df, manifest) → final_df

Dependencies
------------
    Required : pandas, numpy, typing, dataclasses, re, uuid, hashlib, math
    Optional : sklearn (graceful fallback for FREE_TEXT TF-IDF strategy)
"""

from __future__ import annotations

import hashlib
import math
import re
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

# sklearn is optional — FREE_TEXT falls back to random pool sampling
try:
    from sklearn.feature_extraction.text import TfidfVectorizer  # type: ignore
    from sklearn.decomposition import TruncatedSVD               # type: ignore
    from sklearn.neighbors import NearestNeighbors                # type: ignore
    _SKLEARN_AVAILABLE = True
except Exception:
    _SKLEARN_AVAILABLE = False


# Import project error hierarchy for merge_outputs hard-fail
try:
    from pipeline_errors import PipelineHardFail  # type: ignore
except Exception:
    # Standalone usage — define a minimal stand-in
    class PipelineHardFail(Exception):  # type: ignore[no-redef]
        def __init__(self, message: str, stage: str = "unknown", context: Optional[Dict[str, Any]] = None) -> None:
            super().__init__(message)
            self.stage = stage
            self.context = context or {}


# ==================================================================
# Error subclass for merge failures
# ==================================================================

class ColumnMergeError(PipelineHardFail):
    """Raised when merge_outputs detects column mismatch or data corruption."""

    def __init__(self, detail: str, context: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(
            message=f"ColumnMergeError: {detail}",
            stage="preprocessing_merge",
            context=context or {},
        )


# ==================================================================
# Enums
# ==================================================================

class ColumnType(str, Enum):
    CONTINUOUS_NUMERIC    = "CONTINUOUS_NUMERIC"
    DISCRETE_NUMERIC      = "DISCRETE_NUMERIC"
    LOW_CARD_CATEGORICAL  = "LOW_CARD_CATEGORICAL"
    HIGH_CARD_CATEGORICAL = "HIGH_CARD_CATEGORICAL"
    ID_COLUMN             = "ID_COLUMN"
    FREE_TEXT             = "FREE_TEXT"
    DATETIME              = "DATETIME"   # D1: dedicated datetime type


class RouteTag(str, Enum):
    COPULA    = "COPULA"
    DISCRETE  = "DISCRETE"
    LOW_CARD  = "LOW_CARD"
    HIGH_CARD = "HIGH_CARD"
    ID        = "ID"
    FREE_TEXT = "FREE_TEXT"
    DATETIME  = "DATETIME"   # D1


# Type → route mapping
_TYPE_TO_ROUTE: Dict[ColumnType, RouteTag] = {
    ColumnType.CONTINUOUS_NUMERIC:    RouteTag.COPULA,
    ColumnType.DISCRETE_NUMERIC:      RouteTag.DISCRETE,
    ColumnType.LOW_CARD_CATEGORICAL:  RouteTag.LOW_CARD,
    ColumnType.HIGH_CARD_CATEGORICAL: RouteTag.HIGH_CARD,
    ColumnType.ID_COLUMN:             RouteTag.ID,
    ColumnType.FREE_TEXT:             RouteTag.FREE_TEXT,
    ColumnType.DATETIME:              RouteTag.DATETIME,  # D1
}


# ==================================================================
# Dataclasses
# ==================================================================

@dataclass
class ColumnManifest:
    name:          str
    col_type:      ColumnType
    route:         RouteTag
    pattern:       Optional[str]       = None   # regex if HIGH_CARD_CATEGORICAL
    tfidf_model:   Optional[Any]       = None   # fitted TfidfVectorizer if FREE_TEXT
    svd_model:     Optional[Any]       = None   # fitted TruncatedSVD if FREE_TEXT
    value_pool:    Optional[List[str]] = None   # full pool for FREE_TEXT fallback
    id_strategy:   Optional[str]       = None   # "uuid4" | "sequential" | "hash"
    null_rate:     float               = 0.0
    unique_count:  int                 = 0
    unique_ratio:  float               = 0.0

    # ── Extra metadata used by generation helpers ──
    # Frequency table for DISCRETE_NUMERIC / LOW_CARD / HIGH_CARD sampling
    _freq_table:   Optional[Dict[str, float]] = field(default=None, repr=False)
    # Original dtype string for casting back after generation
    _orig_dtype:   Optional[str]              = field(default=None, repr=False)
    # For sequential ID: start value
    _id_start:     Optional[int]              = field(default=None, repr=False)
    # Latent matrix cache for FREE_TEXT Strategy A
    _latent_matrix: Optional[Any]             = field(default=None, repr=False)
    # Pre-fitted NearestNeighbors model for FREE_TEXT Strategy A (ISSUE 11 fix)
    _nn_model:     Optional[Any]              = field(default=None, repr=False)
    # D1: DATETIME range and format
    _dt_min:       Optional[str]              = field(default=None, repr=False)  # ISO timestamp
    _dt_max:       Optional[str]              = field(default=None, repr=False)  # ISO timestamp
    _dt_fmt:       Optional[str]              = field(default=None, repr=False)  # strftime format


@dataclass
class PreprocessingManifest:
    columns:       Dict[str, ColumnManifest] = field(default_factory=dict)
    copula_cols:   List[str]                 = field(default_factory=list)
    excluded_cols: List[str]                 = field(default_factory=list)
    col_order:     List[str]                 = field(default_factory=list)
    warnings:      List[str]                 = field(default_factory=list)
    encoder:       Optional[Any]             = field(default=None, repr=False)

    def to_dict(self) -> Dict[str, Any]:
        """JSON-serializable representation (strips non-serializable models)."""
        result: Dict[str, Any] = {
            "copula_cols":   self.copula_cols,
            "excluded_cols": self.excluded_cols,
            "col_order":     self.col_order,
            "warnings":      self.warnings,
            "columns":       {},
        }
        for name, cm in self.columns.items():
            result["columns"][name] = {
                "name":         cm.name,
                "col_type":     cm.col_type.value,
                "route":        cm.route.value,
                "pattern":      cm.pattern,
                "id_strategy":  cm.id_strategy,
                "null_rate":    cm.null_rate,
                "unique_count": cm.unique_count,
                "unique_ratio": round(cm.unique_ratio, 6),
                "has_tfidf":    cm.tfidf_model is not None,
                "has_svd":      cm.svd_model is not None,
                "value_pool_size": len(cm.value_pool) if cm.value_pool else 0,
            }
        result["encoder"] = self.encoder.to_dict() if self.encoder is not None else None
        return result


# ==================================================================
# Compiled regex patterns (module-level, zero side effects at import)
# ==================================================================

_ID_NAME_RE = re.compile(r'(^id$|_id$|^uuid|^hash|^key$|^index$)', re.IGNORECASE)

_PATTERN_TEMPLATES: List[Tuple[str, str]] = [
    ("email",       r'^[^@]+@[\w.-]+\.\w{2,}$'),
    ("url",         r'^https?://'),
    ("ip_address",  r'^\d{1,3}(\.\d{1,3}){3}$'),
    ("phone",       r'^[\+\d][\d\s\-\(\)]{7,}$'),
    ("zip_numeric", r'^\d{4,6}$'),
    ("zip_alpha",   r'^\w{3,4}\s?\w{3}$'),
    ("iso_date",    r'^\d{4}-\d{2}-\d{2}'),
    ("hash_hex",    r'^[a-f0-9]{32,}$'),
    ("hash_b64",    r'^[A-Za-z0-9+/]{20,}={0,2}$'),
]

# Pre-compiled regex patterns (ISSUE 17 fix: compiled once at module import)
_COMPILED_PATTERN_TEMPLATES: List[Tuple[str, str, re.Pattern]] = [
    (label, pat, re.compile(pat)) for label, pat in _PATTERN_TEMPLATES
]

_UUID_RE = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    re.IGNORECASE,
)
_HASH_HEX_RE = re.compile(r'^[a-f0-9]{32,}$', re.IGNORECASE)

# Compiled once at module level (G7 fix: was recompiled on every column call)
_PROPER_NAME_RE = re.compile(r"^[A-Z][a-zA-Z\s\-\.']+$")


# ==================================================================
# POLICY OVERRIDE HELPER
# ==================================================================

def _force_column_type(
    col_name:     str,
    series:       pd.Series,
    forced_type:  ColumnType,
    null_rate:    float,
    unique_count: int,
    unique_ratio: float,
) -> ColumnManifest:
    """
    Build a ColumnManifest with the type forced by policy override.
    Uses sensible defaults for auxiliary fields based on the target type.
    """
    non_null = series.dropna()
    base_kwargs = dict(
        name=col_name,
        null_rate=null_rate,
        unique_count=unique_count,
        unique_ratio=unique_ratio,
    )

    if forced_type == ColumnType.HIGH_CARD_CATEGORICAL:
        pool = non_null.astype(str).tolist()
        freq = _build_frequency_table(non_null.astype(str) if len(non_null) > 0 else pd.Series(dtype=str))
        cm = ColumnManifest(
            **base_kwargs,
            col_type=ColumnType.HIGH_CARD_CATEGORICAL,
            route=RouteTag.HIGH_CARD,
            value_pool=pool,
        )
        cm._freq_table = freq
        cm._orig_dtype = str(series.dtype)
        return cm

    if forced_type == ColumnType.LOW_CARD_CATEGORICAL:
        freq = _build_frequency_table(non_null.astype(str) if len(non_null) > 0 else pd.Series(dtype=str))
        cm = ColumnManifest(
            **base_kwargs,
            col_type=ColumnType.LOW_CARD_CATEGORICAL,
            route=RouteTag.LOW_CARD,
        )
        cm._freq_table = freq
        cm._orig_dtype = str(series.dtype)
        return cm

    if forced_type == ColumnType.FREE_TEXT:
        tfidf, svd, pool, latent = _fit_freetext_model(non_null)
        cm = ColumnManifest(
            **base_kwargs,
            col_type=ColumnType.FREE_TEXT,
            route=RouteTag.FREE_TEXT,
            value_pool=pool if pool else non_null.astype(str).tolist(),
            tfidf_model=tfidf,
            svd_model=svd,
        )
        cm._latent_matrix = latent
        cm._orig_dtype = str(series.dtype)
        return cm

    if forced_type == ColumnType.ID_COLUMN:
        is_numeric = pd.api.types.is_numeric_dtype(series)
        strategy = _determine_id_strategy(series, non_null, is_numeric)
        cm = ColumnManifest(
            **base_kwargs,
            col_type=ColumnType.ID_COLUMN,
            route=RouteTag.ID,
            id_strategy=strategy,
        )
        if strategy == "sequential" and is_numeric and len(non_null) > 0:
            cm._id_start = int(non_null.max())
        cm._orig_dtype = str(series.dtype)
        return cm

    if forced_type == ColumnType.CONTINUOUS_NUMERIC:
        return ColumnManifest(
            **base_kwargs,
            col_type=ColumnType.CONTINUOUS_NUMERIC,
            route=RouteTag.COPULA,
            _orig_dtype=str(series.dtype),
        )

    if forced_type == ColumnType.DISCRETE_NUMERIC:
        freq = _build_frequency_table(non_null.astype(int).astype(str) if len(non_null) > 0 else pd.Series(dtype=str))
        cm = ColumnManifest(
            **base_kwargs,
            col_type=ColumnType.DISCRETE_NUMERIC,
            route=RouteTag.DISCRETE,
        )
        cm._freq_table = freq
        cm._orig_dtype = str(series.dtype)
        return cm

    # Fallback — should never reach here given ColumnType enum exhaustion
    freq = _build_frequency_table(non_null.astype(str) if len(non_null) > 0 else pd.Series(dtype=str))
    cm = ColumnManifest(
        **base_kwargs,
        col_type=ColumnType.LOW_CARD_CATEGORICAL,
        route=RouteTag.LOW_CARD,
    )
    cm._freq_table = freq
    return cm


# ==================================================================
# PUBLIC API
# ==================================================================

def build_manifest(
    df:       pd.DataFrame,
    baseline: Dict[str, Any],
    overrides: Optional[Dict[str, Any]] = None,
    target_type: Optional[str] = None,
    target_col:  Optional[str] = None,
) -> PreprocessingManifest:
    """
    Classify every column. Return manifest.
    Never raises — all errors go into manifest.warnings.

    Parameters
    ----------
    df        : original dataset DataFrame
    baseline  : BaselineArtifact dict produced by baseline.py
    overrides : optional dict from policy.yaml ``synthetic_data`` section.
                Supported keys:
                  ``excluded_columns``     — list of column names to route as
                                             FREE_TEXT pool-sampling (keeps
                                             schema intact, skips copula/stats)
                  ``column_type_overrides`` — {col_name: ColumnType str} to
                                              force a specific classification
    target_type : "regression" | "classification" | None — mirrors
                  BaselineReader.target_type (generator.py). Passed through
                  to CategoricalEncoder so it can prioritise the regression
                  target as an encoding partner (see Strategy 0 in
                  CategoricalEncoder._fit_column).
    target_col  : name of the detected target/label column, mirrors
                  BaselineReader.label_col. None when no target was detected.
    """
    manifest = PreprocessingManifest()
    manifest.col_order = list(df.columns)
    manifest.warnings = []

    _excluded_cols: set = set((overrides or {}).get("excluded_columns", []))
    _type_overrides: Dict[str, str] = (overrides or {}).get("column_type_overrides", {})

    # Extract baseline column classifications for override-warning comparison
    bl_numeric_cols = set((baseline.get("columns") or {}).get("numeric", {}).keys())
    bl_categorical_cols = set((baseline.get("columns") or {}).get("categorical", {}).keys())

    for col_name in df.columns:
        try:
            series = df[col_name]
            non_null = series.dropna()
            null_rate = float(series.isna().mean())
            unique_count = int(non_null.nunique()) if len(non_null) > 0 else 0
            unique_ratio = unique_count / max(len(non_null), 1)

            # ── Policy: excluded columns ──────────────────────────────────
            if col_name in _excluded_cols:
                pool = non_null.astype(str).tolist()
                cm = ColumnManifest(
                    name=col_name,
                    col_type=ColumnType.FREE_TEXT,
                    route=RouteTag.FREE_TEXT,
                    value_pool=pool,
                    null_rate=null_rate,
                    unique_count=unique_count,
                    unique_ratio=unique_ratio,
                )
                manifest.columns[col_name] = cm
                manifest.warnings.append(
                    f"column '{col_name}' excluded by policy: "
                    "routed to pool-sampling (schema preserved)"
                )
                continue

            # ── Policy: forced column type override ───────────────────────
            if col_name in _type_overrides:
                forced_str = _type_overrides[col_name]
                try:
                    forced_type = ColumnType(forced_str)
                    cm = _force_column_type(
                        col_name, series, forced_type,
                        null_rate, unique_count, unique_ratio,
                    )
                    manifest.columns[col_name] = cm
                    manifest.warnings.append(
                        f"column '{col_name}' type forced to "
                        f"{forced_type.value} by policy override"
                    )
                    continue
                except ValueError:
                    manifest.warnings.append(
                        f"column '{col_name}': unknown override type "
                        f"'{forced_str}', falling back to auto-classification"
                    )

            cm = _classify_column(col_name, series, df, baseline)

            # Log override warnings when our classification disagrees with baseline
            if col_name in bl_numeric_cols and cm.col_type != ColumnType.CONTINUOUS_NUMERIC:
                manifest.warnings.append(
                    f"column '{col_name}' reclassified from baseline numeric "
                    f"to {cm.col_type.value}: unique_ratio={cm.unique_ratio:.3f}, "
                    f"unique_count={cm.unique_count}"
                )
            elif col_name in bl_categorical_cols and cm.col_type not in (
                ColumnType.LOW_CARD_CATEGORICAL,
                ColumnType.HIGH_CARD_CATEGORICAL,
            ):
                manifest.warnings.append(
                    f"column '{col_name}' reclassified from baseline categorical "
                    f"to {cm.col_type.value}: unique_ratio={cm.unique_ratio:.3f}, "
                    f"unique_count={cm.unique_count}"
                )

            manifest.columns[col_name] = cm

        except Exception as exc:
            # Never raise — record and fall back to LOW_CARD_CATEGORICAL
            manifest.warnings.append(
                f"column '{col_name}' classification failed ({type(exc).__name__}: "
                f"{exc}); defaulting to LOW_CARD_CATEGORICAL"
            )
            manifest.columns[col_name] = ColumnManifest(
                name=col_name,
                col_type=ColumnType.LOW_CARD_CATEGORICAL,
                route=RouteTag.LOW_CARD,
                null_rate=float(df[col_name].isna().mean()),
                unique_count=int(df[col_name].nunique()),
                unique_ratio=float(df[col_name].nunique() / max(len(df[col_name].dropna()), 1)),
            )

    # ── Fit CategoricalEncoder on encodable columns ─────────────────
    try:
        encoder = CategoricalEncoder()
        encoder._target_columns = [
            name for name, cm_ in manifest.columns.items()
            if cm_.col_type in (
                ColumnType.LOW_CARD_CATEGORICAL,
                ColumnType.DISCRETE_NUMERIC,
            )
        ]
        encoder.target_type = target_type
        encoder.target_col  = target_col
        encoder.fit(df, baseline)
        manifest.encoder = encoder
        manifest.warnings.extend(encoder.warnings)
    except Exception as exc:
        manifest.warnings.append(
            f"CategoricalEncoder failed ({type(exc).__name__}: {exc}); "
            "all categoricals will be generated independently"
        )
        manifest.encoder = None

    # ── Partition columns into copula / encoder-handled / excluded ──
    encoded_set = set(
        manifest.encoder.columns_handled if manifest.encoder else []
    )
    for col_name, cm in manifest.columns.items():
        if cm.route == RouteTag.COPULA:
            manifest.copula_cols.append(col_name)
        elif col_name in encoded_set:
            pass  # encoder manages this column — not independently generated
        else:
            manifest.excluded_cols.append(col_name)

    return manifest


def apply_manifest(
    manifest: PreprocessingManifest,
    df:       pd.DataFrame,
    n:        int,
    rng:      np.random.Generator,
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """
    Returns:
      copula_df   — CONTINUOUS_NUMERIC cols + encoded categoricals,
                    ready for math engine input
      excluded_df — pre-generated synthetic values for truly excluded cols
                    (IDs, free text, and any categoricals the encoder skipped)
    The caller (generator.py) merges both after copula sampling.
    """
    # ── 1. Build copula-safe dataframe (CONTINUOUS_NUMERIC columns) ──
    copula_cols_present = [c for c in manifest.copula_cols if c in df.columns]
    copula_df = df[copula_cols_present].copy() if copula_cols_present else pd.DataFrame()

    # ── 2. Encode categoricals and concat into copula_df ─────────────
    if manifest.encoder is not None and manifest.encoder.columns_in_copula:
        encoded_cats = manifest.encoder.encode(df)
        if len(encoded_cats.columns) > 0:
            copula_df = pd.concat(
                [copula_df.reset_index(drop=True),
                 encoded_cats.reset_index(drop=True)],
                axis=1,
            )

    # ── 3. Pre-generate synthetic values for truly excluded columns ──
    excluded_data: Dict[str, np.ndarray] = {}
    for col_name in manifest.excluded_cols:
        cm = manifest.columns[col_name]
        try:
            values = _generate_excluded_column(cm, df, col_name, n, rng)
        except Exception:
            # Fallback: random sample from original (with replacement)
            pool = df[col_name].dropna().values
            if len(pool) > 0:
                values = rng.choice(pool, size=n, replace=True)
            else:
                values = np.array([None] * n, dtype=object)
        excluded_data[col_name] = values

    excluded_df = pd.DataFrame(excluded_data)

    # Apply null masks to excluded columns based on original null rates
    for col_name in manifest.excluded_cols:
        cm = manifest.columns[col_name]
        if cm.null_rate > 0.0:
            null_mask = rng.random(n) < cm.null_rate
            arr = excluded_df[col_name].values.astype(object)
            arr[null_mask] = None
            excluded_df[col_name] = arr

    return copula_df, excluded_df


def merge_outputs(
    copula_output: pd.DataFrame,
    excluded_df:   pd.DataFrame,
    manifest:      PreprocessingManifest,
    rng:           Optional[np.random.Generator] = None,
) -> pd.DataFrame:
    """
    Merge copula output + excluded columns back into original col_order.

    Steps:
      1. Decode encoded categorical columns from copula_output
      2. Drop synthetic encoded column names (``col__enc``)
      3. Assemble final DataFrame from: copula numerics + decoded
         categoricals + excluded columns
      4. Apply null rates to decoded columns (requires *rng*)
      5. Validate: row count, column set, no unexpected NaN

    Raises ColumnMergeError (subclass of PipelineHardFail) on mismatch.
    """
    expected_cols = set(manifest.col_order)

    # ── Phase 1: Decode encoded categoricals ─────────────────────────
    decoded_data: Dict[str, np.ndarray] = {}
    enc_col_names_to_drop: set = set()

    if manifest.encoder is not None:
        decoded_df = manifest.encoder.decode(copula_output, rng=rng)
        for col in decoded_df.columns:
            decoded_data[col] = decoded_df[col].values
        for orig_col in manifest.encoder.columns_handled:
            enc_col_names_to_drop.update(
                manifest.encoder.encoded_col_names(orig_col)
            )

    # ── Phase 2: Determine available column sources ──────────────────
    have_copula = set()
    if len(copula_output) > 0:
        have_copula = set(copula_output.columns) - enc_col_names_to_drop

    have_decoded  = set(decoded_data.keys())
    have_excluded = set(excluded_df.columns) if len(excluded_df) > 0 else set()
    have_all      = have_copula | have_decoded | have_excluded

    # ── Phase 3: Validate completeness ───────────────────────────────
    missing = expected_cols - have_all
    if missing:
        raise ColumnMergeError(
            f"Missing columns after merge: {sorted(missing)}",
            context={"missing": sorted(missing), "expected": sorted(expected_cols)},
        )

    # Check for duplicated columns across the three sources
    for label, set_a, set_b in [
        ("copula vs decoded",  have_copula,  have_decoded),
        ("copula vs excluded", have_copula,  have_excluded),
        ("decoded vs excluded", have_decoded, have_excluded),
    ]:
        overlap = set_a & set_b
        if overlap:
            raise ColumnMergeError(
                f"Columns duplicated between {label}: {sorted(overlap)}",
                context={"duplicated": sorted(overlap), "source": label},
            )

    # Determine row count
    n = 0
    for source in (copula_output, excluded_df):
        if len(source) > 0:
            if n == 0:
                n = len(source)
            elif len(source) != n:
                raise ColumnMergeError(
                    f"Row count mismatch: copula has {len(copula_output)}, "
                    f"excluded has {len(excluded_df)}",
                    context={"copula_rows": len(copula_output),
                             "excluded_rows": len(excluded_df)},
                )
    # decoded_data inherits row count from copula_output

    # ── Phase 4: Assemble final dataframe in original column order ───
    merged_data: Dict[str, Any] = {}
    for col in manifest.col_order:
        if col in have_copula:
            merged_data[col] = copula_output[col].values
        elif col in have_decoded:
            merged_data[col] = decoded_data[col]
        elif col in have_excluded:
            merged_data[col] = excluded_df[col].values

    final_df = pd.DataFrame(merged_data, columns=manifest.col_order)

    # ── Phase 5: Apply null rates to decoded columns ─────────────────
    if manifest.encoder is not None and rng is not None:
        for col in manifest.encoder.columns_handled:
            cm = manifest.columns.get(col)
            if cm is not None and cm.null_rate > 0.0 and col in final_df.columns:
                null_mask = rng.random(n) < cm.null_rate
                arr = final_df[col].values.astype(object)
                arr[null_mask] = None
                final_df[col] = arr

    # ── Phase 5b: Apply null rates to copula columns ──────────────────
    # Copula columns bypass the decoder path in Phase 5, so their null_rate
    # was never applied (G4 fix). Apply it here using the same mechanism.
    if rng is not None:
        for col in manifest.copula_cols:
            cm = manifest.columns.get(col)
            if cm is not None and cm.null_rate > 0.0 and col in final_df.columns:
                null_mask = rng.random(n) < cm.null_rate
                arr = final_df[col].values.astype(object)
                arr[null_mask] = None
                final_df[col] = arr

    # ── Phase 6: Final validation ────────────────────────────────────
    if len(final_df) != n:
        raise ColumnMergeError(
            f"Final dataframe has {len(final_df)} rows, expected {n}",
            context={"actual": len(final_df), "expected": n},
        )

    if set(final_df.columns) != expected_cols:
        raise ColumnMergeError(
            f"Final column set mismatch: "
            f"extra={sorted(set(final_df.columns) - expected_cols)}, "
            f"missing={sorted(expected_cols - set(final_df.columns))}",
        )

    # Validate no NaN introduced by merge itself
    # (Columns with null_rate > 0 may have NaN from injection above.)
    for col in manifest.col_order:
        cm = manifest.columns.get(col)
        if cm is None:
            continue
        if cm.null_rate == 0.0:
            nan_count = int(final_df[col].isna().sum())
            if nan_count > 0:
                raise ColumnMergeError(
                    f"Merge introduced {nan_count} NaN values in column "
                    f"'{col}' (null_rate=0.0 in manifest)",
                    context={"column": col, "nan_count": nan_count},
                )

    return final_df


# ==================================================================
# CLASSIFICATION ENGINE (priority-ordered, first match wins)
# ==================================================================

def _classify_column(
    col_name: str,
    series:   pd.Series,
    df:       pd.DataFrame,
    baseline: Dict[str, Any],
) -> ColumnManifest:
    """Run the 6-step priority classification. First match wins."""
    non_null = series.dropna()
    n_total  = len(series)
    n_valid  = len(non_null)

    null_rate    = float(series.isna().mean())
    unique_count = int(non_null.nunique()) if n_valid > 0 else 0
    unique_ratio = unique_count / max(n_valid, 1)
    is_numeric   = pd.api.types.is_numeric_dtype(series)
    is_object    = series.dtype == object or pd.api.types.is_string_dtype(series)
    orig_dtype   = str(series.dtype)

    base_kwargs = dict(
        name=col_name,
        null_rate=null_rate,
        unique_count=unique_count,
        unique_ratio=unique_ratio,
    )

    # ── Priority 0: DATETIME ───────────────────────────────────────
    # Check native datetime64 dtype first; also probe object columns
    # by parsing a sample — if ≥90% parse as valid dates it is datetime.
    _is_datetime = pd.api.types.is_datetime64_any_dtype(series)
    if not _is_datetime and is_object and n_valid > 0:
        try:
            _sample_dt = non_null.head(200)
            _parsed_dt = pd.to_datetime(_sample_dt, infer_datetime_format=True, errors="coerce")
            _is_datetime = float(_parsed_dt.notna().mean()) >= 0.90
        except Exception:
            _is_datetime = False

    if _is_datetime:
        try:
            _dt_series = pd.to_datetime(series, errors="coerce").dropna()
            if len(_dt_series) > 0:
                _dt_min_str = _dt_series.min().isoformat()
                _dt_max_str = _dt_series.max().isoformat()
                # Detect format: use time-aware format if any value contains a time component
                _first_val = str(_dt_series.iloc[0])
                _dt_fmt    = "%Y-%m-%dT%H:%M:%S" if "T" in _first_val or " " in _first_val else "%Y-%m-%d"
            else:
                _dt_min_str, _dt_max_str, _dt_fmt = None, None, "%Y-%m-%dT%H:%M:%S"
        except Exception:
            _dt_min_str, _dt_max_str, _dt_fmt = None, None, "%Y-%m-%dT%H:%M:%S"
        cm = ColumnManifest(
            **base_kwargs,
            col_type=ColumnType.DATETIME,
            route=RouteTag.DATETIME,
        )
        cm._dt_min    = _dt_min_str
        cm._dt_max    = _dt_max_str
        cm._dt_fmt    = _dt_fmt
        cm._orig_dtype = orig_dtype
        return cm

    # ── Priority 1: ID_COLUMN ──────────────────────────────────────
    if _is_id_column(col_name, series, non_null, unique_ratio, unique_count, n_total, is_numeric):
        strategy = _determine_id_strategy(series, non_null, is_numeric)
        id_start = None
        if strategy == "sequential" and is_numeric and n_valid > 0:
            id_start = int(non_null.max())
        cm = ColumnManifest(
            **base_kwargs,
            col_type=ColumnType.ID_COLUMN,
            route=RouteTag.ID,
            id_strategy=strategy,
        )
        cm._id_start = id_start
        cm._orig_dtype = orig_dtype
        return cm

    # ── Priority 2: FREE_TEXT ──────────────────────────────────────
    if is_object and unique_ratio > 0.70 and n_valid > 0:
        avg_tokens = float(non_null.astype(str).str.split().str.len().mean())
        if avg_tokens > 3:
            tfidf, svd, pool, latent, nn_model = _fit_freetext_model(non_null)
            cm = ColumnManifest(
                **base_kwargs,
                col_type=ColumnType.FREE_TEXT,
                route=RouteTag.FREE_TEXT,
                tfidf_model=tfidf,
                svd_model=svd,
                value_pool=pool,
            )
            cm._latent_matrix = latent
            cm._nn_model = nn_model
            cm._orig_dtype = orig_dtype
            return cm

    # ── Priority 3: HIGH_CARD_CATEGORICAL ──────────────────────────
    # Original threshold was unique_count > 50 — too high for real-world
    # datasets like US states (exactly 50 values).  Lowered to > 15 with
    # a meaningful unique_ratio floor so small low-card columns (region,
    # gender, etc.) still fall through to LOW_CARD_CATEGORICAL.
    if is_object and unique_count > 15 and unique_ratio > 0.40:
        pattern = _detect_pattern(non_null)
        # Classified as HIGH_CARD whether or not a pattern is found
        freq = _build_frequency_table(non_null)
        cm = ColumnManifest(
            **base_kwargs,
            col_type=ColumnType.HIGH_CARD_CATEGORICAL,
            route=RouteTag.HIGH_CARD,
            pattern=pattern,
            value_pool=non_null.astype(str).tolist(),
        )
        cm._freq_table = freq
        cm._orig_dtype = orig_dtype
        return cm

    # ── Priority 4: DISCRETE_NUMERIC ──────────────────────────────
    if is_numeric and n_valid > 0 and unique_count <= 50:
        if _all_integers(non_null):
            freq = _build_frequency_table(non_null.astype(int).astype(str))
            cm = ColumnManifest(
                **base_kwargs,
                col_type=ColumnType.DISCRETE_NUMERIC,
                route=RouteTag.DISCRETE,
            )
            cm._freq_table = freq
            cm._orig_dtype = orig_dtype
            return cm

    # ── Priority 5: CONTINUOUS_NUMERIC ─────────────────────────────
    # Note: we do NOT gate on unique_ratio < 0.95 here.  Numeric IDs are
    # already caught by Priority 1 (monotonic integer check), so any numeric
    # column that reaches this point is a legitimate continuous variable —
    # even if it has very high cardinality (e.g. salary with 199/200 unique).
    if is_numeric:
        # Additional guard: not an integer sequence with step=1 and low card
        if not (_all_integers(non_null) and unique_count <= 50):
            return ColumnManifest(
                **base_kwargs,
                col_type=ColumnType.CONTINUOUS_NUMERIC,
                route=RouteTag.COPULA,
                _orig_dtype=orig_dtype,
            )

    # ── Priority 6: LOW_CARD_CATEGORICAL (catch-all) ──────────────
    freq = _build_frequency_table(non_null.astype(str) if n_valid > 0 else pd.Series(dtype=str))
    cm = ColumnManifest(
        **base_kwargs,
        col_type=ColumnType.LOW_CARD_CATEGORICAL,
        route=RouteTag.LOW_CARD,
    )
    cm._freq_table = freq
    cm._orig_dtype = orig_dtype
    return cm


# ==================================================================
# DETECTION HELPERS
# ==================================================================

def _is_id_column(
    col_name:     str,
    series:       pd.Series,
    non_null:     pd.Series,
    unique_ratio: float,
    unique_count: int,
    n_total:      int,
    is_numeric:   bool,
) -> bool:
    """Priority 1 — ID column detection.

    Design decisions:
    - For *numeric* columns, high unique_ratio alone is NOT sufficient.
      Continuous floats (salary, temperature) are naturally high-cardinality.
      We require monotonic integer sequence evidence.
    - For *string/object* columns with high unique_ratio, we must exclude
      values that are better explained as FREE_TEXT (avg tokens > 3) or
      patterned data (emails, URLs, etc.) — those have their own dedicated
      type handlers downstream.  Only structureless short strings that look
      like identifiers (UUIDs, hashes, opaque tokens) should be ID.
    """
    # Criterion B: name matches common ID patterns (any dtype)
    if _ID_NAME_RE.search(col_name):
        return True

    # Criterion C: numeric + monotonic integer + all unique
    if is_numeric and len(non_null) > 0:
        try:
            if (non_null.is_monotonic_increasing
                    and unique_count == n_total
                    and _all_integers(non_null)):
                return True
        except Exception:
            pass

    # Criterion A: almost every row is unique — string/object columns only
    if not is_numeric and unique_ratio > 0.95 and len(non_null) > 0:
        str_vals = non_null.astype(str)

        # Exclude FREE_TEXT: multi-word strings are text, not identifiers
        avg_tokens = float(str_vals.str.split().str.len().mean())
        if avg_tokens > 3:
            return False

        # Exclude patterned data: emails, URLs, dates, etc.
        # These are better handled by HIGH_CARD_CATEGORICAL
        for _label, _pat, compiled in _COMPILED_PATTERN_TEMPLATES:
            coverage = float(str_vals.head(200).apply(
                lambda v: bool(compiled.match(v))
            ).mean())
            if coverage > 0.70:
                return False

        # Exclude proper-name columns: geographic names, state/country names,
        # entity names, etc.  These are meaningful categorical values that
        # should be pool-sampled, not replaced with UUIDs.
        # Heuristic: if >70% of values are capitalised words (letters, spaces,
        # hyphens, apostrophes only) they are names, not opaque identifiers.
        # _PROPER_NAME_RE is compiled at module level (G7 fix).
        name_coverage = float(
            str_vals.head(200)
            .apply(lambda v: bool(_PROPER_NAME_RE.match(v)))
            .mean()
        )
        if name_coverage > 0.70:
            return False

        return True

    return False


def _determine_id_strategy(
    series:     pd.Series,
    non_null:   pd.Series,
    is_numeric: bool,
) -> str:
    """Select ID generation strategy based on original data characteristics."""
    # Sequential: any integer column (monotonic ordering not required —
    # requiring it caused non-monotonic integer IDs to fall through to the
    # "uuid4" default, producing string values for a column the baseline
    # already classified as numeric, which then failed the NO_NAN invariant
    # when pd.to_numeric coerced every UUID string to NaN).
    if is_numeric and len(non_null) > 0:
        try:
            if _all_integers(non_null):
                return "sequential"
        except Exception:
            pass

    # UUID: string values matching UUID pattern
    if not is_numeric and len(non_null) > 0:
        sample = non_null.head(min(100, len(non_null))).astype(str)
        uuid_matches = sample.apply(lambda v: bool(_UUID_RE.match(v)))
        if uuid_matches.mean() > 0.80:
            return "uuid4"

        # Hash: hex hash pattern
        hash_matches = sample.apply(lambda v: bool(_HASH_HEX_RE.match(v)))
        if hash_matches.mean() > 0.80:
            return "hash"

    # Default
    return "uuid4"


def _all_integers(series: pd.Series) -> bool:
    """Check if all non-null values are whole numbers."""
    if pd.api.types.is_integer_dtype(series):
        return True
    try:
        vals = series.dropna().values
        return bool(np.all(np.equal(np.mod(vals, 1), 0)))
    except Exception:
        return False


def _detect_pattern(series: pd.Series) -> Optional[str]:
    """
    Try pattern templates in order.
    Return first regex that covers > 70% of non-null values, or None.
    """
    if len(series) == 0:
        return None

    str_vals = series.dropna().astype(str)
    n_vals = len(str_vals)
    if n_vals == 0:
        return None

    for _label, pattern, compiled in _COMPILED_PATTERN_TEMPLATES:
        matches = str_vals.apply(lambda v: bool(compiled.match(v)))
        coverage = float(matches.mean())
        if coverage > 0.70:
            return pattern

    return None


def _build_frequency_table(series: pd.Series) -> Dict[str, float]:
    """Build a normalised frequency table from a series (all values, not top_k)."""
    if len(series) == 0:
        return {}
    vc = series.value_counts(normalize=True, dropna=True)
    return {str(k): float(v) for k, v in vc.items()}


# ==================================================================
# FREE_TEXT MODEL FITTING
# ==================================================================

def _fit_freetext_model(
    series: pd.Series,
) -> Tuple[Optional[Any], Optional[Any], List[str], Optional[Any], Optional[Any]]:
    """
    Fit TF-IDF + SVD + NearestNeighbors on non-null text values.
    Returns (tfidf, svd, value_pool, latent_matrix, nn_model).
    Falls back to (None, None, pool, None, None) if sklearn unavailable.
    """
    pool = series.dropna().astype(str).tolist()

    if not _SKLEARN_AVAILABLE or len(pool) < 2:
        return None, None, pool, None, None

    try:
        tfidf = TfidfVectorizer(max_features=200, min_df=1)
        tfidf_matrix = tfidf.fit_transform(pool)

        n_components = min(20, tfidf_matrix.shape[0] - 1, tfidf_matrix.shape[1])
        if n_components < 1:
            return None, None, pool, None, None

        svd = TruncatedSVD(n_components=n_components)
        latent = svd.fit_transform(tfidf_matrix)

        nn = NearestNeighbors(n_neighbors=1, metric="euclidean")
        nn.fit(latent)

        return tfidf, svd, pool, latent, nn
    except Exception:
        return None, None, pool, None, None


# ==================================================================
# GENERATION STRATEGIES (called by apply_manifest)
# ==================================================================

def _generate_excluded_column(
    cm:       ColumnManifest,
    df:       pd.DataFrame,
    col_name: str,
    n:        int,
    rng:      np.random.Generator,
) -> np.ndarray:
    """Dispatch to the appropriate generation strategy for an excluded column."""
    if cm.route == RouteTag.ID:
        return _generate_ids(cm, n, rng)
    elif cm.route == RouteTag.FREE_TEXT:
        return _sample_freetext(cm, n, rng)
    elif cm.route == RouteTag.HIGH_CARD:
        return _sample_high_card(cm, n, rng)
    elif cm.route == RouteTag.DISCRETE:
        return _sample_discrete_numeric(cm, n, rng)
    elif cm.route == RouteTag.LOW_CARD:
        return _sample_low_card(cm, n, rng)
    elif cm.route == RouteTag.DATETIME:  # D1
        return _generate_datetime(cm, n, rng)
    else:
        # Fallback — random sample from original
        pool = df[col_name].dropna().values
        if len(pool) > 0:
            return rng.choice(pool, size=n, replace=True)
        return np.array([None] * n, dtype=object)


def _generate_datetime(
    cm:  ColumnManifest,
    n:   int,
    rng: np.random.Generator,
) -> np.ndarray:
    """
    D1: Generate n datetime strings by uniform random sampling within
    the observed [dt_min, dt_max] range.

    Values are returned as ISO 8601 strings (JSON-safe).
    Falls back to a pool-sample from the original if range data is missing.
    """
    fmt = cm._dt_fmt or "%Y-%m-%dT%H:%M:%S"
    try:
        dt_min = pd.Timestamp(cm._dt_min) if cm._dt_min else pd.Timestamp("2000-01-01")
        dt_max = pd.Timestamp(cm._dt_max) if cm._dt_max else pd.Timestamp("2024-12-31")
        span   = (dt_max - dt_min).total_seconds()
        if span <= 0:
            # Degenerate: all values identical → repeat the single timestamp
            ts_str = dt_min.strftime(fmt)
            return np.array([ts_str] * n, dtype=object)
        offsets = rng.uniform(0.0, span, size=n)
        timestamps = dt_min + pd.to_timedelta(offsets, unit="s")
        return timestamps.strftime(fmt).values
    except Exception:
        # Graceful fallback: emit ISO "epoch" strings
        return np.array(["2000-01-01T00:00:00"] * n, dtype=object)


def _generate_ids(cm: ColumnManifest, n: int, rng: np.random.Generator) -> np.ndarray:
    """Generate fresh synthetic IDs — never from copula, never from top_k."""
    strategy = cm.id_strategy or "uuid4"

    if strategy == "sequential":
        start = (cm._id_start or 0) + 1
        return np.arange(start, start + n)

    if strategy == "hash":
        return np.array(
            [hashlib.md5(str(rng.integers(0, 2**128)).encode()).hexdigest()
             for _ in range(n)],
            dtype=object,
        )

    # Default: uuid4 — deterministic from seeded rng
    return np.array(
        [str(uuid.UUID(int=int(rng.integers(0, 2**128)))) for _ in range(n)],
        dtype=object,
    )


def _sample_freetext(cm: ColumnManifest, n: int, rng: np.random.Generator) -> np.ndarray:
    """
    Strategy A: TF-IDF → SVD → sample in latent space → nearest-neighbor decode.
    Strategy B (fallback): random sample from full value pool.
    """
    pool = cm.value_pool
    if not pool:
        return np.array([None] * n, dtype=object)

    # Strategy A: latent-space sampling
    if cm.tfidf_model is not None and cm.svd_model is not None and cm._latent_matrix is not None:
        try:
            latent = cm._latent_matrix  # shape: (pool_size, n_components)

            # Fit a Gaussian to the latent space (diagonal covariance for stability)
            mu = latent.mean(axis=0)
            var = latent.var(axis=0)
            # Prevent zero variance
            var = np.maximum(var, 1e-8)

            # Sample n points from the Gaussian
            sampled = rng.normal(loc=mu, scale=np.sqrt(var), size=(n, len(mu)))

            # Nearest-neighbor decode back to original text (ISSUE 11 fix: use pre-fitted model)
            if cm._nn_model is not None:
                nn = cm._nn_model
            else:
                nn = NearestNeighbors(n_neighbors=1, metric="euclidean")
                nn.fit(latent)
            _, indices = nn.kneighbors(sampled)
            indices = indices.flatten()

            return np.array([pool[i] for i in indices], dtype=object)

        except Exception:
            pass  # Fall through to Strategy B

    # Strategy B: uniform random from full pool (NOT top_k, NOT frequency-weighted)
    indices = rng.integers(0, len(pool), size=n)
    return np.array([pool[i] for i in indices], dtype=object)


def _sample_high_card(cm: ColumnManifest, n: int, rng: np.random.Generator) -> np.ndarray:
    """
    Pattern-aware sampling for HIGH_CARD_CATEGORICAL columns.
    If a pattern exists: sample from the full value pool (preserves structure).
    If no pattern: weighted frequency sampling from the full pool.
    """
    # Use the full value pool when available (NOT top_k truncated)
    if cm.value_pool and len(cm.value_pool) > 0:
        pool = cm.value_pool
        # Use frequency weights when available to preserve the original
        # distribution shape instead of flattening to uniform.
        if cm._freq_table and len(cm._freq_table) > 0:
            freq = cm._freq_table
            weights = np.array([freq.get(str(v), 1e-9) for v in pool], dtype=float)
            weights = weights / weights.sum()
            idx = rng.choice(len(pool), size=n, p=weights)
        else:
            idx = rng.integers(0, len(pool), size=n)
        return np.array([pool[i] for i in idx], dtype=object)

    # Fallback: frequency table sampling
    if cm._freq_table:
        choices = list(cm._freq_table.keys())
        weights = np.array(list(cm._freq_table.values()), dtype=float)
        weights = weights / weights.sum()
        idx = rng.choice(len(choices), size=n, p=weights)
        return np.array(choices, dtype=object)[idx]

    return np.array([None] * n, dtype=object)


def _sample_discrete_numeric(cm: ColumnManifest, n: int, rng: np.random.Generator) -> np.ndarray:
    """
    Weighted frequency sampling for DISCRETE_NUMERIC.
    Preserves integer constraint — values are always whole numbers.
    """
    if not cm._freq_table:
        return np.zeros(n, dtype=int)

    choices_str = list(cm._freq_table.keys())
    weights = np.array(list(cm._freq_table.values()), dtype=float)
    weights = weights / weights.sum()

    idx = rng.choice(len(choices_str), size=n, p=weights)
    selected = np.array(choices_str, dtype=object)[idx]

    # Cast back to integer
    try:
        return np.array([int(float(v)) for v in selected], dtype=int)
    except (ValueError, TypeError):
        return selected


def _sample_low_card(cm: ColumnManifest, n: int, rng: np.random.Generator) -> np.ndarray:
    """Weighted frequency sampling for LOW_CARD_CATEGORICAL."""
    if not cm._freq_table:
        return np.array([None] * n, dtype=object)

    choices = list(cm._freq_table.keys())
    weights = np.array(list(cm._freq_table.values()), dtype=float)
    weights = weights / weights.sum()
    idx = rng.choice(len(choices), size=n, p=weights)
    return np.array(choices, dtype=object)[idx]


# ==================================================================
# CategoricalEncoder — translate categoricals into copula-safe
#                      continuous representations
# ==================================================================

_PB_THRESHOLD = 0.3   # min |point-biserial r| for strong partner
_CV_THRESHOLD = 0.3   # min Cramer's V for strong partner


@dataclass
class _ColEncoding:
    """Internal encoding spec for a single column."""
    strategy:      str                    # "pb_mean" | "cramers_weighted" | "cumprob" | "constant"
    category_map:  Dict[str, float]       # category_value -> encoded float
    encoded_names: List[str]              # column name(s) after encoding
    categories:    List[str]              # all category values (sorted)
    partner:       Optional[str] = None   # partner column name (pb/cramers)


class CategoricalEncoder:
    """
    Encode categorical columns into continuous representations so they
    can enter the Gaussian Copula alongside CONTINUOUS_NUMERIC columns.

    Encoding strategies (selected per-column based on baseline signals):

    1. **pb_mean** — strong point-biserial partner (|r| >= 0.3):
       Each category is encoded as the conditional mean of the numeric
       partner.  This directly preserves the cat-num relationship.

    2. **cramers_weighted** — strong Cramer's V partner (V >= 0.3):
       Each category is encoded as the weighted average of the partner's
       frequency-ranked categories, using the conditional distribution
       P(partner | category).  Captures cat-cat association structure.

    3. **cumprob** — isolated column (no strong partners):
       Each category is mapped to the midpoint of its interval in a
       Laplace-smoothed cumulative probability distribution.  Values
       are strictly inside (0, 1), never at boundaries.

    All strategies produce strictly continuous values with no degenerate
    point masses at {0, 1}.  ``decode()`` uses vectorised nearest-neighbour
    lookup and always returns values from the original category set.
    """

    def __init__(self) -> None:
        self.warnings: List[str] = []
        self._encodings: Dict[str, _ColEncoding] = {}
        # Set by build_manifest before fit() to restrict which columns
        # the encoder should handle.
        self._target_columns: Optional[List[str]] = None
        # Set by build_manifest before fit() — mirrors BaselineReader's
        # target_type/label_col (generator.py). Used by Strategy 0 in
        # _fit_column to prioritise the regression target as a partner.
        self.target_type: Optional[str] = None
        self.target_col:  Optional[str] = None

    # ── Properties ────────────────────────────────────────────────

    @property
    def columns_in_copula(self) -> List[str]:
        """Columns whose encoded representations enter the copula."""
        return [c for c, e in self._encodings.items()
                if e.strategy != "constant"]

    @property
    def columns_handled(self) -> List[str]:
        """All columns the encoder manages (including constants)."""
        return list(self._encodings.keys())

    # ── Public interface ──────────────────────────────────────────

    def fit(self, df: pd.DataFrame, baseline: Dict[str, Any]) -> None:
        """
        Learn encoding mappings for all target categorical columns.
        Never raises — log warnings to self.warnings.
        """
        cols = self._target_columns if self._target_columns is not None else []

        pb_corr = (baseline.get("correlations") or {}).get(
            "categorical_numeric_pb", {}
        )
        cv_corr = (baseline.get("correlations") or {}).get(
            "categorical_cramers_v", {}
        )

        for col in cols:
            try:
                self._fit_column(col, df, pb_corr, cv_corr)
            except Exception as exc:
                self.warnings.append(
                    f"CategoricalEncoder: column '{col}' encoding failed "
                    f"({type(exc).__name__}: {exc})"
                )

    def encode(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Replace categorical columns with continuous representations.
        Returns only the encoded columns as a DataFrame.
        """
        result: Dict[str, np.ndarray] = {}

        for col, enc in self._encodings.items():
            if enc.strategy == "constant" or not enc.encoded_names:
                continue
            if col not in df.columns:
                continue

            cat_series = df[col].astype(str)
            global_mean = float(np.mean(list(enc.category_map.values())))
            encoded = cat_series.map(enc.category_map).fillna(global_mean)
            result[enc.encoded_names[0]] = encoded.values

        return pd.DataFrame(result, index=df.index)

    def decode(self, df: pd.DataFrame, rng: Optional[np.random.Generator] = None) -> pd.DataFrame:
        """
        Map continuous columns back to original category values.
        Output values always within the original category set.

        FIX-05: uses a temperature-calibrated softmax over distance to
        each category's encoded center, sampled via `rng`, instead of
        deterministic nearest-neighbor snapping. A value exactly halfway
        between two category encodings under deterministic argmin always
        resolves to the same category; real conditional distributions
        show stochastic mixing near such boundaries. Temperature
        auto-calibrates per column to 1/4 of that column's minimum
        inter-category gap, so well-separated categories still decode
        almost deterministically while tightly-packed ones mix more.

        This replaces the previous small pre-snap Gaussian jitter (whose
        only documented purpose was the same boundary-smoothing goal) —
        the two are not layered, since stacking two independent
        randomization mechanisms for one statistical problem would make
        the effective smoothing un-auditable and harder to reason about.

        rng : optional random generator. When None, decoding falls back
              to deterministic nearest-neighbor (matches the previous
              no-rng behavior exactly).
        """
        result: Dict[str, np.ndarray] = {}

        for col, enc in self._encodings.items():
            # Constant columns: fill with the single known value
            if enc.strategy == "constant":
                n_rows = len(df)
                result[col] = np.full(n_rows, enc.categories[0], dtype=object)
                continue

            enc_name = enc.encoded_names[0]
            if enc_name not in df.columns:
                continue

            cat_keys = np.array(list(enc.category_map.keys()), dtype=object)
            centers  = np.array(list(enc.category_map.values()), dtype=float)
            values   = df[enc_name].values.astype(float).reshape(-1, 1)  # (n, 1)
            distances = np.abs(values - centers.reshape(1, -1))          # (n, k)

            if rng is not None and len(centers) >= 2:
                sorted_centers = np.sort(centers)
                gaps = np.diff(sorted_centers)
                temperature = float(gaps.min()) / 4.0 if len(gaps) > 0 else 0.1
                temperature = max(temperature, 1e-8)

                logits = -distances / temperature
                logits -= logits.max(axis=1, keepdims=True)  # numerical stability
                probs = np.exp(logits)
                probs /= probs.sum(axis=1, keepdims=True)

                # Vectorized categorical sampling via the Gumbel-max trick
                # (equivalent to rng.choice(k, p=row_probs) per row, but
                # without a Python-level loop over n rows).
                gumbel = -np.log(-np.log(rng.uniform(1e-12, 1.0, size=probs.shape)))
                chosen_idx = np.argmax(np.log(probs + 1e-300) + gumbel, axis=1)
            else:
                chosen_idx = np.argmin(distances, axis=1)

            result[col] = cat_keys[chosen_idx]

        return pd.DataFrame(result)

    def encoded_col_names(self, original_col: str) -> List[str]:
        """
        Return the list of continuous column names that represent
        this categorical column after encoding.
        """
        enc = self._encodings.get(original_col)
        if enc is None:
            return []
        return list(enc.encoded_names)

    def to_dict(self) -> Dict[str, Any]:
        """
        Serialize all encoder state.  Fully JSON-serializable
        (no numpy types, no model objects).
        """
        cols_dict: Dict[str, Any] = {}
        for col, enc in self._encodings.items():
            cols_dict[col] = {
                "strategy":      enc.strategy,
                "category_map":  {k: float(v) for k, v in enc.category_map.items()},
                "encoded_names": enc.encoded_names,
                "categories":    enc.categories,
                "partner":       enc.partner,
            }
        return {
            "warnings": list(self.warnings),
            "columns":  cols_dict,
        }

    # ── Fit helpers ───────────────────────────────────────────────

    def _fit_column(
        self,
        col:     str,
        df:      pd.DataFrame,
        pb:      Dict[str, float],
        cv:      Dict[str, float],
    ) -> None:
        """Determine strategy and compute encoding for *col*."""
        if col not in df.columns:
            return

        series = df[col].dropna()
        if len(series) == 0:
            return

        categories = sorted(series.astype(str).unique().tolist())

        if len(categories) == 0:
            return

        # Single unique value — no copula dimension needed
        if len(categories) == 1:
            self._encodings[col] = _ColEncoding(
                strategy="constant",
                category_map={categories[0]: 0.5},
                encoded_names=[],
                categories=categories,
            )
            return

        # Strategy 0: if this is a regression task, ALWAYS try the target
        # itself as the pb partner first — regardless of the normal
        # _PB_THRESHOLD gate. For a regression target, preserving this
        # column's relationship with the target matters more than the
        # threshold that exists to avoid noisy/spurious encodings in the
        # general case.
        if (
            self.target_type == "regression"
            and self.target_col is not None
            and self.target_col in df.columns
            and self.target_col != col
        ):
            enc = self._fit_pb_encoding(col, self.target_col, df, categories)
            if enc is not None:
                self._encodings[col] = enc
                return
            # _fit_pb_encoding returned None (degenerate/binary partner) —
            # fall through to the normal strategy chain below rather than
            # forcing a broken encoding.

        # Strategy 1: point-biserial partner
        pb_partner = self._find_pb_partner(col, pb)
        if pb_partner is not None and pb_partner in df.columns:
            enc = self._fit_pb_encoding(col, pb_partner, df, categories)
            if enc is not None:
                self._encodings[col] = enc
                return

        # Strategy 2: Cramer's V partner
        cv_partner = self._find_cv_partner(col, cv, df)
        if cv_partner is not None and cv_partner in df.columns:
            enc = self._fit_cv_encoding(col, cv_partner, df, categories)
            if enc is not None:
                self._encodings[col] = enc
                return

        # Strategy 3: isolated — Laplace-smoothed cumulative probability
        self.warnings.append(
            f"column '{col}': no strong correlation partner, "
            f"using isolated cumulative-probability encoding"
        )
        self._encodings[col] = self._fit_isolated_encoding(
            col, series, categories
        )

    # ── Partner discovery ─────────────────────────────────────────

    @staticmethod
    def _find_pb_partner(
        col: str, pb: Dict[str, float],
    ) -> Optional[str]:
        """Return the strongest point-biserial numeric partner, or None."""
        best: Optional[str] = None
        best_r = 0.0
        for key, r in pb.items():
            parts = key.split("__", 1)
            if len(parts) != 2:
                continue
            cat_col, num_col = parts
            if cat_col == col and abs(r) >= _PB_THRESHOLD and abs(r) > best_r:
                best, best_r = num_col, abs(r)
        return best

    @staticmethod
    def _find_cv_partner(
        col: str, cv: Dict[str, float], df: Optional[pd.DataFrame] = None,
    ) -> Optional[str]:
        """
        Return the strongest Cramer's V categorical partner, or None.

        FIX-09: raw Cramer's V has positive finite-sample bias that grows
        with cardinality (bias ~= sqrt((k1-1)(k2-1)/n)), which can inflate
        V enough to select a spurious high-cardinality partner over a
        genuinely stronger low-cardinality one. When `df` is available,
        each candidate's V is bias-corrected (Bergsma, 2013) before
        comparison. `df` is optional (defaults to None, using raw V) so
        this stays backward compatible with any caller that doesn't have
        the DataFrame on hand.
        """
        best: Optional[str] = None
        best_v = 0.0
        for key, v in cv.items():
            parts = key.split("__", 1)
            if len(parts) != 2:
                continue
            a, b = parts
            partner = b if a == col else (a if b == col else None)
            if partner is None or abs(v) < _CV_THRESHOLD:
                continue

            v_compare = abs(v)
            if df is not None and col in df.columns and partner in df.columns:
                pair = df[[col, partner]].dropna()
                n_obs = len(pair)
                if n_obs > 1:
                    k1 = pair[col].astype(str).nunique()
                    k2 = pair[partner].astype(str).nunique()
                    bias_term = (k1 - 1) * (k2 - 1) / (n_obs - 1)
                    v_compare = max(0.0, v ** 2 - bias_term) ** 0.5

            if v_compare > best_v:
                best, best_v = partner, v_compare
        return best

    # ── Strategy 1: point-biserial conditional mean ───────────────

    @staticmethod
    def _fit_pb_encoding(
        col:        str,
        partner:    str,
        df:         pd.DataFrame,
        categories: List[str],
    ) -> Optional[_ColEncoding]:
        """
        Encode each category as the conditional mean of the numeric partner.

        Guarantees:
        - Values are continuous (means of real data)
        - Never at hard boundaries (means sit inside range)
        - Directly reflects the statistical relationship
        """
        enc_name = f"{col}__enc"
        cat_series = df[col].astype(str)
        num_series = pd.to_numeric(df[partner], errors="coerce")

        global_mean = float(num_series.mean())
        if math.isnan(global_mean):
            return None
        global_var = float(num_series.var(ddof=1))
        if math.isnan(global_var):
            global_var = 0.0

        # FIX-16: James-Stein shrinkage of each category's conditional mean
        # toward the grand mean. For rare categories the raw sample mean is
        # noisy; JS (1961) proves shrinking toward the grand mean dominates
        # the raw per-group mean in MSE whenever there are >= 3 groups.
        # Below 3 categories the (k-2) term in the JS formula is <= 1 and
        # the estimator loses its dominance guarantee, so we fall back to
        # the raw mean in that case.
        use_james_stein = len(categories) >= 3 and global_var > 0
        cat_map: Dict[str, float] = {}
        for cat in categories:
            vals = num_series[cat_series == cat].dropna()
            n_cat = len(vals)
            if n_cat == 0:
                cat_map[cat] = global_mean
                continue
            cat_mean = float(vals.mean())
            if use_james_stein:
                sq_dev = n_cat * (cat_mean - global_mean) ** 2
                shrink = max(
                    0.0,
                    1 - (len(categories) - 2) * global_var / max(1e-10, sq_dev),
                )
                cat_map[cat] = global_mean + shrink * (cat_mean - global_mean)
            else:
                cat_map[cat] = cat_mean

        # Guard: if the numeric partner is a true binary column (only 0 and 1
        # as values), its conditional means land exactly at 0.0 and 1.0, which
        # map to ±∞ under Φ⁻¹. Fall through to cumprob in that case.
        # IMPORTANT: we inspect num_series (the actual partner data), NOT
        # cat_map (whose keys are category labels, not partner values — G5 fix).
        num_unique = set(num_series.dropna().unique())
        partner_is_binary = num_unique.issubset({0.0, 1.0}) and len(num_unique) <= 2
        if partner_is_binary:
            return None

        # Degenerate: all categories map to the same value
        if len(set(round(v, 12) for v in cat_map.values())) < 2:
            return None

        return _ColEncoding(
            strategy="pb_mean",
            category_map=cat_map,
            encoded_names=[enc_name],
            categories=categories,
            partner=partner,
        )

    # ── Strategy 2: Cramer's V weighted rank ──────────────────────

    @staticmethod
    def _fit_cv_encoding(
        col:        str,
        partner:    str,
        df:         pd.DataFrame,
        categories: List[str],
    ) -> Optional[_ColEncoding]:
        """
        Encode each category as the weighted average of the partner's
        frequency-ranked categories, using P(partner | category).

        The partner's categories are ranked by descending frequency;
        each source category receives a weighted sum of those ranks
        based on its conditional distribution over the partner.
        """
        enc_name = f"{col}__enc"
        cat_series = df[col].astype(str)
        partner_series = df[partner].dropna().astype(str)

        if partner_series.nunique() < 2:
            return None

        # Rank partner categories by frequency
        partner_vc = partner_series.value_counts()
        partner_ranks = {
            str(cat): float(i) for i, cat in enumerate(partner_vc.index)
        }
        max_rank = float(len(partner_ranks) - 1) if len(partner_ranks) > 1 else 1.0

        cat_map: Dict[str, float] = {}
        for cat in categories:
            sub = df[partner][cat_series == cat].dropna().astype(str)
            if len(sub) == 0:
                cat_map[cat] = max_rank / 2.0
                continue
            sub_vc = sub.value_counts(normalize=True)
            weighted = sum(
                partner_ranks.get(str(p), 0.0) * float(prob)
                for p, prob in sub_vc.items()
            )
            cat_map[cat] = float(weighted)

        if len(set(round(v, 12) for v in cat_map.values())) < 2:
            return None

        return _ColEncoding(
            strategy="cramers_weighted",
            category_map=cat_map,
            encoded_names=[enc_name],
            categories=categories,
            partner=partner,
        )

    # ── Strategy 3: Laplace-smoothed cumulative probability ───────

    @staticmethod
    def _fit_isolated_encoding(
        col:        str,
        series:     pd.Series,
        categories: List[str],
    ) -> _ColEncoding:
        """
        Encode using KT-smoothed cumulative probability midpoints.

        P(class_i) = (count_i + 0.5) / (n + k * 0.5)
        midpoint_i = CDF(i-1) + P(i) / 2

        Values are always strictly inside (0, 1), never at boundaries.
        """
        enc_name = f"{col}__enc"
        vc = series.astype(str).value_counts()
        n_total = len(series)
        k = len(categories)

        # Order by frequency (most frequent first)
        sorted_cats = [str(c) for c in vc.index]
        for cat in categories:
            if cat not in sorted_cats:
                sorted_cats.append(cat)

        # FIX-06: Krichevsky-Trofimov estimator replaces Laplace smoothing.
        # KT adds 0.5 pseudo-counts per category (k/2 total) instead of 1
        # (k total), which is minimax-optimal and has strictly lower MSE
        # than Laplace for moderate-to-large k. See Krichevsky & Trofimov
        # (1981).
        probs: Dict[str, float] = {}
        for cat in sorted_cats:
            count = int(vc.get(cat, 0))
            probs[cat] = (count + 0.5) / (n_total + k * 0.5)

        # Cumulative midpoints
        cumsum = 0.0
        cat_map: Dict[str, float] = {}
        for cat in sorted_cats:
            p = probs[cat]
            cat_map[cat] = cumsum + p / 2.0
            cumsum += p

        return _ColEncoding(
            strategy="cumprob",
            category_map=cat_map,
            encoded_names=[enc_name],
            categories=categories,
        )


# ==================================================================
# __main__ — standalone testing
# ==================================================================

if __name__ == "__main__":
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(
        description="preprocessing_layer.py — classify columns and print manifest summary"
    )
    parser.add_argument("csv_path", help="Path to the CSV dataset file")
    parser.add_argument("baseline_json_path", help="Path to the baseline JSON file")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = parser.parse_args()

    # Load data
    df = pd.read_csv(args.csv_path)
    with open(args.baseline_json_path, "r", encoding="utf-8") as f:
        baseline = json.load(f)

    # Build manifest
    manifest = build_manifest(df, baseline)

    # Print summary
    indent = 2 if args.pretty else None
    print(json.dumps(manifest.to_dict(), indent=indent, ensure_ascii=False))
    sys.exit(0)
