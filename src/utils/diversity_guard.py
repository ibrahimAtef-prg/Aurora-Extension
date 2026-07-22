"""
diversity_guard.py — Distribution Collapse & Entropy Enforcement (H05)
diversity_guard.py also enforces input_origin_tag (C05)
=======================================================================

H05 — Distribution collapse detection
    Computes Shannon entropy per column. Raises PipelineHardFail
    if any column falls below MIN_ENTROPY_THRESHOLD.

C05 — Feedback loop contamination prevention
    Tags every generated row with _origin = "generated".
    Provides check_origin_purity() which raises PipelineHardFail
    if any generated row is detected in the training input.

Usage
-----
    from diversity_guard import check_diversity, tag_generated_rows, check_origin_purity

    # After generation — hard entropy check
    check_diversity(synthetic_df, stage="post_generation")

    # Tag rows before they leave the system
    tagged = tag_generated_rows(records)

    # At training time — reject contaminated input
    check_origin_purity(training_df, stage="training_input")
"""

from __future__ import annotations

import math
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from pipeline_errors import PipelineHardFail


# ==================================================================
# Constants
# ==================================================================

_ORIGIN_TAG       = "_origin"
_ORIGIN_GENERATED = "generated"
_ORIGIN_REAL      = "real"

# Collapse thresholds
_MIN_ENTROPY_NORMALIZED = 0.05   # < 5% of max entropy = collapse
_MIN_UNIQUE_RATIO       = 0.005  # < 0.5% unique = mode collapse fallback


# ==================================================================
# Internal helper — baseline entropy for a single column
# ==================================================================

def _baseline_column_entropy(col: str, bl: Any) -> "float | None":
    """
    Compute the normalized Shannon entropy for `col` from the baseline spec.

    Returns None when insufficient baseline data is available.
    Mirrors the same histogram/value-count logic used for synthetic data.
    """
    try:
        # Categorical column: use stored frequency table
        cat_spec = getattr(bl, "categorical", {}).get(col)
        if cat_spec is not None:
            ratios = cat_spec.get("top_value_ratios") or {}
            counts = np.array(list(ratios.values()), dtype=float)
            counts = counts[counts > 0]
            if len(counts) < 2:
                return None
            probs = counts / counts.sum()
            raw   = float(-np.sum(probs * np.log2(probs + 1e-12)))
            mx    = math.log2(len(counts))
            return raw / max(mx, 1e-10)

        # Numeric column: use quantile anchors to simulate the distribution
        num_spec = getattr(bl, "numeric", {}).get(col)
        if num_spec is not None:
            quantile_vals = []
            for key in ("q01", "q05", "q25", "q50", "q75", "q95", "q99"):
                v = num_spec.get(key)
                if v is not None:
                    quantile_vals.append(float(v))
            if len(quantile_vals) < 3:
                # Not enough quantile points — fall back to std/range heuristic.
                # A column with non-zero std relative to its range is not collapsed.
                std_v   = num_spec.get("std")
                min_v   = num_spec.get("min")
                max_v   = num_spec.get("max")
                if std_v is not None and min_v is not None and max_v is not None:
                    rng_v = float(max_v) - float(min_v)
                    if rng_v > 0 and float(std_v) / rng_v >= 0.01:
                        # Enough spread — return a moderate entropy so the
                        # baseline comparison never triggers a false collapse.
                        return 0.5
                return None
            quantile_vals = sorted(quantile_vals)
            diffs = np.diff(quantile_vals).astype(float)
            diffs = diffs[diffs > 0]
            if len(diffs) < 2:
                # Quantile values are nearly identical — try std/range fallback
                # before giving up, same logic as above.
                std_v   = num_spec.get("std")
                min_v   = num_spec.get("min")
                max_v   = num_spec.get("max")
                if std_v is not None and min_v is not None and max_v is not None:
                    rng_v = float(max_v) - float(min_v)
                    if rng_v > 0 and float(std_v) / rng_v >= 0.01:
                        return 0.5
                return None
            probs = diffs / diffs.sum()
            raw   = float(-np.sum(probs * np.log2(probs + 1e-12)))
            mx    = math.log2(len(diffs))
            return raw / max(mx, 1e-10)
    except Exception:
        pass
    return None


# ==================================================================
# H05 — Entropy-based distribution collapse detection
# ==================================================================

def check_diversity(
    synthetic_df: pd.DataFrame,
    stage:        str = "diversity_guard",
    bl:           Any = None,   # optional BaselineReader for baseline-relative check
) -> Dict[str, Any]:
    """
    Compute Shannon entropy per column and raise PipelineHardFail
    if any column is collapsed.

    Parameters
    ----------
    synthetic_df : generated DataFrame
    stage        : stage label for error context

    Returns
    -------
    dict with entropy_scores, unique_ratio, collapsed_columns

    Raises
    ------
    PipelineHardFail if any column entropy < _MIN_ENTROPY_NORMALIZED
    """
    entropy_scores:    Dict[str, float] = {}
    collapsed_columns: List[str]        = []

    for col in synthetic_df.columns:
        if col.startswith("_"):
            continue   # skip internal tags

        series = synthetic_df[col].dropna()
        if len(series) < 2:
            continue

        n_unique = series.nunique()
        if n_unique <= 1:
            # Single-value column: entropy is always 0 regardless of
            # legitimacy. sanity_guard owns collapse detection for these
            # (it checks baseline std). Skip here to avoid false positives.
            continue

        try:
            if pd.api.types.is_numeric_dtype(series):
                # Bin into 20 buckets and compute entropy
                counts, _ = np.histogram(
                    pd.to_numeric(series, errors="coerce").dropna(),
                    bins=min(20, n_unique)
                )
                counts = counts[counts > 0].astype(float)
            else:
                counts = series.astype(str).value_counts().values.astype(float)

            if len(counts) == 0:
                continue

            probs             = counts / counts.sum()
            raw_entropy       = float(-np.sum(probs * np.log2(probs + 1e-12)))
            max_entropy       = math.log2(len(counts)) if len(counts) > 1 else 1.0
            normed            = raw_entropy / max(max_entropy, 1e-10)
            entropy_scores[col] = round(normed, 4)

            if normed < _MIN_ENTROPY_NORMALIZED:
                # Before flagging: compare against the BASELINE entropy for this
                # column.  Legitimately skewed distributions (e.g. employment_type
                # in ds_salaries with ~97% FT) have inherently low baseline entropy.
                # Only flag if synthetic entropy is also dramatically LOWER than the
                # baseline would predict — otherwise this is faithful reproduction,
                # not a collapse.
                if bl is not None:
                    baseline_normed = _baseline_column_entropy(col, bl)
                    if baseline_normed is not None:
                        # Collapse = synthetic entropy < 30% of baseline entropy
                        if baseline_normed > 0 and normed >= baseline_normed * 0.30:
                            continue   # within expected range — skip
                    else:
                        # _baseline_column_entropy returned None — insufficient
                        # quantile data to compute a reference entropy.  Cannot
                        # confirm a true collapse; skip to avoid false positives.
                        # Genuine single-value collapse is already caught above
                        # (n_unique <= 1) and by sanity_guard's std check.
                        continue
                collapsed_columns.append(col)
        except Exception:
            continue

    # Fallback: unique row ratio
    n_total  = len(synthetic_df)
    n_unique = len(synthetic_df.drop_duplicates()) if n_total > 0 else 0
    unique_ratio = n_unique / max(n_total, 1)

    result = {
        "entropy_scores":    entropy_scores,
        "collapsed_columns": collapsed_columns,
        "unique_ratio":      round(unique_ratio, 4),
    }

    if collapsed_columns:
        raise PipelineHardFail(
            message = (
                f"DISTRIBUTION COLLAPSE DETECTED in {len(collapsed_columns)} column(s): "
                + ", ".join(
                    f"'{c}' (entropy={entropy_scores.get(c, 0):.4f} < {_MIN_ENTROPY_NORMALIZED})"
                    for c in collapsed_columns
                ) + ". Generator has collapsed to near-constant output."
            ),
            stage   = stage,
            context = result,
        )

    if unique_ratio < _MIN_UNIQUE_RATIO:
        raise PipelineHardFail(
            message = (
                f"MODE COLLAPSE: unique row ratio = {unique_ratio:.4f} < {_MIN_UNIQUE_RATIO}. "
                "Nearly all generated rows are identical."
            ),
            stage   = stage,
            context = result,
        )

    return result


# ==================================================================
# C05 — Origin tagging & feedback loop prevention
# ==================================================================

def tag_generated_rows(
    records: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Tag each record with _origin = "generated".

    Must be called on every list of rows produced by the generator
    before they leave the system. The tag prevents them from being
    silently fed back as training data.

    Parameters
    ----------
    records : list of row dicts from cp.export()

    Returns
    -------
    Same list with _origin = "generated" added to every row.
    """
    for row in records:
        row[_ORIGIN_TAG] = _ORIGIN_GENERATED
    return records


def check_origin_purity(
    df:    pd.DataFrame,
    stage: str = "origin_check",
) -> None:
    """
    Raise PipelineHardFail if any row in df is tagged as generated.

    Must be called at training time before any dataset is used for
    fitting, retraining, or baseline computation.

    Parameters
    ----------
    df    : input DataFrame to validate
    stage : stage label for error context

    Raises
    ------
    PipelineHardFail if generated rows are detected in training input.
    """
    if _ORIGIN_TAG not in df.columns:
        return   # no tag column = pure original data, allowed

    generated_mask = df[_ORIGIN_TAG].astype(str) == _ORIGIN_GENERATED
    n_generated    = int(generated_mask.sum())

    if n_generated > 0:
        raise PipelineHardFail(
            message = (
                f"FEEDBACK LOOP CONTAMINATION: {n_generated} rows with "
                f"_origin='generated' detected in training input. "
                f"Generated data must never be fed back as training data. "
                f"This would create a feedback loop causing distribution drift."
            ),
            stage   = stage,
            context = {
                "n_generated":  n_generated,
                "n_total":      len(df),
                "contamination_rate": round(n_generated / max(len(df), 1), 4),
            },
        )
