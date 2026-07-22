"""
system_invariants.py — Hard System Invariants
===============================================

Checks data integrity at every stage boundary.
ANY violation raises InvariantViolation (PipelineHardFail subclass).
There is NO recovery — a violation means corrupt data reached the
boundary, which is ALWAYS a bug in the preceding stage.

Invariants enforced
-------------------
1. NO_NAN         — no NaN or Inf values in any numeric column
2. NO_EMPTY       — output DataFrame must not be empty (zero rows)
3. SCHEMA_MATCH   — all expected columns are present
4. COL_ORDER      — column order matches the baseline col_order exactly
5. CAT_VALIDITY   — categorical column values are within allowed set
6. ROW_COUNT      — generated row count within specified tolerance
7. TYPE_SAFETY    — numeric columns contain numeric values only

Public API
----------
    check_dataframe(df, bl, stage, n_requested=None)
        Run all applicable invariants. Raises InvariantViolation on failure.

    check_output_dict(output, stage)
        Validate the JSON output dict from a pipeline stage.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Set

import numpy as np
import pandas as pd

from pipeline_errors import InvariantViolation, assert_hard


# ==================================================================
# Tolerance constants
# ==================================================================

_ROW_COUNT_TOLERANCE = 0.0   # must be exact when partial=False
_MAX_PARTIAL_RATIO   = 1.0   # 100% — partial completions allowed up to 100%


# ==================================================================
# Individual invariant checks
# ==================================================================

def _check_no_nan(df: pd.DataFrame, numeric_cols: List[str], stage: str) -> None:
    """Invariant 1: no NaN or Inf in any numeric column."""
    for col in numeric_cols:
        if col not in df.columns:
            continue
        s = df[col]
        nan_count = int(pd.to_numeric(s, errors="coerce").isna().sum())
        inf_count = int(
            np.isinf(
                pd.to_numeric(s, errors="coerce")
                  .fillna(0)
                  .values
                  .astype(float)
            ).sum()
        )
        assert_hard(
            nan_count == 0,
            InvariantViolation(
                invariant = "NO_NAN",
                detail    = f"Column '{col}' contains {nan_count} NaN value(s)",
                stage     = stage,
                context   = {"column": col, "nan_count": nan_count},
            ),
        )
        assert_hard(
            inf_count == 0,
            InvariantViolation(
                invariant = "NO_INF",
                detail    = f"Column '{col}' contains {inf_count} Inf value(s)",
                stage     = stage,
                context   = {"column": col, "inf_count": inf_count},
            ),
        )


def _check_no_empty(df: pd.DataFrame, stage: str) -> None:
    """Invariant 2: DataFrame must not be empty."""
    assert_hard(
        len(df) > 0,
        InvariantViolation(
            invariant = "NO_EMPTY",
            detail    = "DataFrame has zero rows",
            stage     = stage,
        ),
    )


def _check_schema_match(
    df:              pd.DataFrame,
    expected_cols:   List[str],
    stage:           str,
    allow_extra:     bool = False,
) -> None:
    """Invariant 3: all expected columns are present."""
    present: Set[str] = set(df.columns)
    expected: Set[str] = set(expected_cols)

    missing = expected - present
    assert_hard(
        len(missing) == 0,
        InvariantViolation(
            invariant = "SCHEMA_MATCH",
            detail    = f"Missing columns: {sorted(missing)}",
            stage     = stage,
            context   = {"missing": sorted(missing), "present": sorted(present)},
        ),
    )

    if not allow_extra:
        extra = present - expected
        assert_hard(
            len(extra) == 0,
            InvariantViolation(
                invariant = "SCHEMA_MATCH",
                detail    = f"Unexpected extra columns: {sorted(extra)}",
                stage     = stage,
                context   = {"extra": sorted(extra)},
            ),
        )


def _check_col_order(
    df:         pd.DataFrame,
    col_order:  List[str],
    stage:      str,
) -> None:
    """Invariant 4: column order must match baseline col_order exactly."""
    df_cols = [c for c in df.columns if c in set(col_order)]
    ref_cols = [c for c in col_order if c in set(df.columns)]
    assert_hard(
        df_cols == ref_cols,
        InvariantViolation(
            invariant = "COL_ORDER",
            detail    = (
                f"Column order mismatch.\n"
                f"  Expected: {ref_cols}\n"
                f"  Got:      {df_cols}"
            ),
            stage   = stage,
            context = {"expected": ref_cols, "got": df_cols},
        ),
    )


def _check_cat_validity(
    df:      pd.DataFrame,
    allowed: Dict[str, List[str]],
    stage:   str,
) -> None:
    """Invariant 5: categorical values must be within the allowed set."""
    for col, allowed_vals in allowed.items():
        if col not in df.columns or not allowed_vals:
            continue
        allowed_set      = set(str(v) for v in allowed_vals)
        col_vals         = df[col].dropna().astype(str)
        invalid          = col_vals[~col_vals.isin(allowed_set)]
        n_invalid        = len(invalid)
        assert_hard(
            n_invalid == 0,
            InvariantViolation(
                invariant = "CAT_VALIDITY",
                detail    = (
                    f"Column '{col}' has {n_invalid} value(s) outside "
                    f"allowed set. Examples: {invalid.unique()[:5].tolist()}"
                ),
                stage   = stage,
                context = {
                    "column":      col,
                    "n_invalid":   n_invalid,
                    "examples":    invalid.unique()[:5].tolist(),
                    "allowed_n":   len(allowed_set),
                },
            ),
        )


def _check_row_count(
    actual:     int,
    requested:  int,
    stage:      str,
    allow_partial: bool = True,
) -> None:
    """
    Invariant 6: row count must satisfy the requested target.
    When allow_partial=True (generation may stop early), zero rows are
    still an error; partial is permitted.
    """
    assert_hard(
        actual > 0,
        InvariantViolation(
            invariant = "ROW_COUNT",
            detail    = "Generated zero rows — pipeline produced no output",
            stage     = stage,
            context   = {"requested": requested, "actual": actual},
        ),
    )
    if not allow_partial:
        assert_hard(
            actual >= requested,
            InvariantViolation(
                invariant = "ROW_COUNT",
                detail    = (
                    f"Row count shortfall: got {actual}, requested {requested} "
                    f"({actual/max(requested,1)*100:.1f}%)"
                ),
                stage   = stage,
                context = {"requested": requested, "actual": actual},
            ),
        )


def _check_type_safety(
    df:           pd.DataFrame,
    numeric_cols: List[str],
    stage:        str,
) -> None:
    """Invariant 7: numeric columns must be coercible to float."""
    for col in numeric_cols:
        if col not in df.columns:
            continue
        non_numeric = pd.to_numeric(df[col], errors="coerce").isna().sum() - df[col].isna().sum()
        assert_hard(
            int(non_numeric) == 0,
            InvariantViolation(
                invariant = "TYPE_SAFETY",
                detail    = (
                    f"Column '{col}' declared numeric but contains "
                    f"{non_numeric} non-numeric value(s)"
                ),
                stage   = stage,
                context = {"column": col, "non_numeric_count": int(non_numeric)},
            ),
        )


# ==================================================================
# Public surface
# ==================================================================

def check_dataframe(
    df:            pd.DataFrame,
    bl:            Any,                          # BaselineReader (duck-typed)
    stage:         str,
    n_requested:   Optional[int]  = None,
    allow_partial: bool           = True,
    allow_extra_cols: bool        = False,
) -> None:
    """
    Run all applicable invariant checks on a DataFrame.

    Parameters
    ----------
    df            : DataFrame to check
    bl            : BaselineReader — provides col_order, numeric, categorical, allowed
    stage         : name of the calling pipeline stage (for error messages)
    n_requested   : expected row count; None to skip row-count check
    allow_partial : whether partial row output is acceptable
    allow_extra_cols : whether extra columns are allowed

    Raises
    ------
    InvariantViolation on any violation.
    """
    # 1. row count
    if n_requested is not None:
        _check_row_count(len(df), n_requested, stage, allow_partial=allow_partial)

    # 2. empty check (independent of row count)
    _check_no_empty(df, stage)

    # 3. schema match
    _check_schema_match(df, bl.col_order, stage, allow_extra=allow_extra_cols)

    # 4. column order
    _check_col_order(df, bl.col_order, stage)

    # 5. NaN / Inf in numeric columns
    # Exclude columns whose baseline null_ratio > 0: those columns have NaN
    # deliberately injected by the null-mask step post-generation.  Flagging
    # them here is a false positive — the NaN is expected, not data corruption.
    num_cols = [c for c in bl.numeric if c in df.columns]
    nan_checkable = [
        c for c in num_cols
        if float((bl.numeric.get(c) or {}).get("null_ratio", 0.0)) == 0.0
    ]
    _check_no_nan(df, nan_checkable, stage)

    # 6. type safety — run on all numeric cols (null_ratio > 0 cols still need
    # their non-null values to be coercible to float)
    _check_type_safety(df, num_cols, stage)

    # 7. categorical validity
    if hasattr(bl, "allowed") and bl.allowed:
        _check_cat_validity(df, bl.allowed, stage)


def check_output_dict(output: Dict[str, Any], stage: str) -> None:
    """
    Validate the JSON output dict produced by a CLI stage
    (generator.py, leakage_bridge.py).

    Required keys must be present and non-null.
    Optional keys are verified if present.
    """
    _REQUIRED_GENERATOR_KEYS = {
        "samples", "generator_used", "row_count", "dataset_fingerprint",
    }
    _REQUIRED_LEAKAGE_KEYS = {
        "risk_level", "privacy_score", "statistical_drift",
        "duplicates_rate", "membership_inference_auc",
    }

    if "samples" in output:
        # Generator output
        missing = _REQUIRED_GENERATOR_KEYS - set(output.keys())
        assert_hard(
            len(missing) == 0,
            InvariantViolation(
                invariant = "OUTPUT_SCHEMA",
                detail    = f"Generator output missing required keys: {missing}",
                stage     = stage,
            ),
        )
        assert_hard(
            isinstance(output.get("samples"), list),
            InvariantViolation(
                invariant = "OUTPUT_SCHEMA",
                detail    = "'samples' must be a list",
                stage     = stage,
            ),
        )
        row_count = output.get("row_count", 0)
        samples   = output.get("samples", [])
        assert_hard(
            int(row_count) == len(samples),
            InvariantViolation(
                invariant = "OUTPUT_SCHEMA",
                detail    = (
                    f"row_count ({row_count}) != len(samples) ({len(samples)})"
                ),
                stage = stage,
            ),
        )

    if "privacy_score" in output:
        # Leakage output — key type checks
        ps = output.get("privacy_score")
        if ps is not None:
            assert_hard(
                isinstance(ps, (int, float)) and not math.isnan(float(ps)),
                InvariantViolation(
                    invariant = "OUTPUT_SCHEMA",
                    detail    = f"privacy_score is not a valid float: {ps!r}",
                    stage     = stage,
                ),
            )
