"""
constraint_enforcer.py — Cross-Column Constraint Enforcement (D2)
=================================================================

Parses ``constraint_rules`` from the ``synthetic_data`` section of
``policy.yaml`` and enforces them on a generated DataFrame.

Supported rule types
--------------------
comparison:
    Ensures ``left_col OP right_col`` holds for every row.
    Supported ops: ``<``, ``<=``, ``>``, ``>=``, ``!=``.
    Violations are repaired by clamping the *left* column to a value
    that satisfies the constraint.

    Example::

        constraint_rules:
          - type: comparison
            left: start_date
            op: "<"
            right: end_date

conditional:
    When ``when.column == when.equals``, enforces ``then.column``
    within ``[then.min, then.max]``.  Missing bound = unconstrained.

    Example::

        constraint_rules:
          - type: conditional
            when:
              column: employment_type
              equals: FT
            then:
              column: salary
              min: 0

Hard-fail behaviour
-------------------
After up to ``max_rounds`` repair attempts, if more than
``fail_threshold`` (default 5%) of rows still violate any rule,
``PipelineHardFail`` is raised.

Public API
----------
    load_constraint_rules(dataset_path)  → List[Dict]
    enforce_constraints(df, rules, rng)  → (df, warnings)
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

try:
    from pipeline_errors import PipelineHardFail  # type: ignore
except Exception:
    class PipelineHardFail(Exception):  # type: ignore[no-redef]
        def __init__(self, message: str, stage: str = "unknown", context: Optional[Dict[str, Any]] = None) -> None:
            super().__init__(message)
            self.stage = stage
            self.context = context or {}


# ---------------------------------------------------------------------------
# Policy loader
# ---------------------------------------------------------------------------

def load_constraint_rules(dataset_path: str) -> List[Dict[str, Any]]:
    """
    Search for ``policy.yaml`` relative to *dataset_path* and return the
    ``synthetic_data.constraint_rules`` list.  Returns an empty list when no
    policy file exists or the section is absent.
    """
    search_dirs = [
        os.path.dirname(os.path.abspath(dataset_path)),
        os.path.abspath(dataset_path) if os.path.isdir(dataset_path) else "",
    ]
    for directory in search_dirs:
        if not directory:
            continue
        candidate = os.path.join(directory, "policy.yaml")
        if os.path.isfile(candidate):
            return _parse_policy(candidate)
    return []


def _parse_policy(policy_path: str) -> List[Dict[str, Any]]:
    try:
        import yaml  # type: ignore
        with open(policy_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        synthetic = data.get("synthetic_data") or {}
        rules = synthetic.get("constraint_rules") or []
        if not isinstance(rules, list):
            return []
        return [r for r in rules if isinstance(r, dict) and "type" in r]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Constraint enforcement
# ---------------------------------------------------------------------------

_SUPPORTED_OPS = {"<", "<=", ">", ">=", "!="}

_OP_FUNCS: Dict[str, Any] = {
    "<":  np.less,
    "<=": np.less_equal,
    ">":  np.greater,
    ">=": np.greater_equal,
    "!=": np.not_equal,
}


def enforce_constraints(
    df:            pd.DataFrame,
    rules:         List[Dict[str, Any]],
    rng:           np.random.Generator,
    *,
    max_rounds:    int   = 3,
    fail_threshold: float = 0.05,
    stage:         str   = "constraint_enforcer",
) -> Tuple[pd.DataFrame, List[str]]:
    """
    Apply *rules* to *df*, repairing violations in-place.

    Returns
    -------
    (repaired_df, warnings)

    Raises
    ------
    PipelineHardFail
        If > ``fail_threshold`` of rows still violate any rule after
        ``max_rounds`` repair attempts.
    """
    warnings: List[str] = []
    df = df.copy()

    valid_rules = _validate_rules(rules, df.columns.tolist(), warnings)
    if not valid_rules:
        return df, warnings

    for round_idx in range(max_rounds):
        total_violations = 0
        for rule in valid_rules:
            n_fixed = _apply_rule(df, rule, rng)
            total_violations += n_fixed

        if total_violations == 0:
            break
        warnings.append(
            f"[ConstraintEnforcer] Round {round_idx + 1}: repaired {total_violations} violation(s)."
        )

    # Post-repair violation audit
    final_violations = _count_violations(df, valid_rules)
    if final_violations > 0:
        viol_rate = final_violations / max(len(df), 1)
        msg = (
            f"[ConstraintEnforcer] {final_violations} row(s) still violate constraints "
            f"after {max_rounds} repair rounds (rate={viol_rate:.3%})."
        )
        if viol_rate > fail_threshold:
            raise PipelineHardFail(
                message=msg,
                stage=stage,
                context={"violation_count": final_violations, "violation_rate": viol_rate},
            )
        warnings.append(msg)

    return df, warnings


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _validate_rules(
    rules:   List[Dict[str, Any]],
    columns: List[str],
    warnings: List[str],
) -> List[Dict[str, Any]]:
    """Filter out malformed or inapplicable rules, appending warnings."""
    valid: List[Dict[str, Any]] = []
    col_set = set(columns)
    for rule in rules:
        rtype = rule.get("type")
        if rtype == "comparison":
            left  = rule.get("left")
            op    = rule.get("op")
            right = rule.get("right")
            if not (left and op and right):
                warnings.append(f"[ConstraintEnforcer] Skipping malformed comparison rule: {rule}")
                continue
            if op not in _SUPPORTED_OPS:
                warnings.append(f"[ConstraintEnforcer] Unsupported op '{op}' in rule: {rule}")
                continue
            if left not in col_set or right not in col_set:
                warnings.append(
                    f"[ConstraintEnforcer] Skipping rule — column(s) not in DataFrame: {rule}"
                )
                continue
            valid.append(rule)
        elif rtype == "conditional":
            when = rule.get("when") or {}
            then = rule.get("then") or {}
            w_col  = when.get("column")
            w_eq   = when.get("equals")
            t_col  = then.get("column")
            if not (w_col and t_col):
                warnings.append(f"[ConstraintEnforcer] Skipping malformed conditional rule: {rule}")
                continue
            if w_col not in col_set or t_col not in col_set:
                warnings.append(
                    f"[ConstraintEnforcer] Skipping rule — column(s) not in DataFrame: {rule}"
                )
                continue
            if then.get("min") is None and then.get("max") is None:
                warnings.append(f"[ConstraintEnforcer] Conditional rule has no min/max — skipped: {rule}")
                continue
            valid.append(rule)
        else:
            warnings.append(f"[ConstraintEnforcer] Unknown rule type '{rtype}' — skipped.")
    return valid


def _apply_rule(df: pd.DataFrame, rule: Dict[str, Any], rng: np.random.Generator) -> int:
    """
    Apply a single rule, repairing violations in *df* in-place.
    Returns the number of rows repaired.
    """
    rtype = rule["type"]
    if rtype == "comparison":
        return _apply_comparison(df, rule, rng)
    elif rtype == "conditional":
        return _apply_conditional(df, rule)
    return 0


def _apply_comparison(df: pd.DataFrame, rule: Dict[str, Any], rng: np.random.Generator) -> int:
    """
    Enforce: left_col OP right_col.
    Repair strategy: clamp left_col to satisfy the constraint.
      left < right   → left = right - tiny_offset   (tiny_offset = 1 if int, 1e-6 if float)
      left <= right  → left = right
      left > right   → left = right + tiny_offset
      left >= right  → left = right
      left != right  → left += tiny_offset
    """
    left_col  = rule["left"]
    op        = rule["op"]
    right_col = rule["right"]
    op_fn     = _OP_FUNCS[op]

    try:
        left_arr  = pd.to_numeric(df[left_col],  errors="coerce").values
        right_arr = pd.to_numeric(df[right_col], errors="coerce").values
    except Exception:
        return 0

    valid_mask = ~(np.isnan(left_arr) | np.isnan(right_arr))
    violating  = valid_mask & ~op_fn(left_arr, right_arr)
    n_violations = int(violating.sum())

    if n_violations == 0:
        return 0

    # Determine a sensible epsilon
    is_int_left = pd.api.types.is_integer_dtype(df[left_col])
    epsilon = 1 if is_int_left else 1e-6

    fixed = left_arr.copy()
    if op == "<":
        fixed[violating] = right_arr[violating] - epsilon
    elif op == "<=":
        fixed[violating] = right_arr[violating]
    elif op == ">":
        fixed[violating] = right_arr[violating] + epsilon
    elif op == ">=":
        fixed[violating] = right_arr[violating]
    elif op == "!=":
        fixed[violating] = right_arr[violating] + epsilon

    if is_int_left:
        fixed = np.round(fixed).astype(df[left_col].dtype if pd.api.types.is_integer_dtype(df[left_col]) else int)

    df[left_col] = fixed
    return n_violations


def _apply_conditional(df: pd.DataFrame, rule: Dict[str, Any]) -> int:
    """
    Enforce: when column == value → then_column in [min, max].
    Repair: clamp then_column to [min, max] for violating rows.
    """
    when   = rule["when"]
    then   = rule["then"]
    w_col  = when["column"]
    w_eq   = when.get("equals")
    t_col  = then["column"]
    t_min  = then.get("min")
    t_max  = then.get("max")

    try:
        condition_mask = df[w_col].astype(str) == str(w_eq)
    except Exception:
        return 0

    if not condition_mask.any():
        return 0

    try:
        t_vals = pd.to_numeric(df[t_col], errors="coerce").values.copy()
    except Exception:
        return 0

    violating = np.zeros(len(df), dtype=bool)
    if t_min is not None:
        violating |= condition_mask.values & (t_vals < float(t_min))
    if t_max is not None:
        violating |= condition_mask.values & (t_vals > float(t_max))

    n_violations = int(violating.sum())
    if n_violations == 0:
        return 0

    if t_min is not None:
        below = violating & (t_vals < float(t_min))
        t_vals[below] = float(t_min)
    if t_max is not None:
        above = violating & (t_vals > float(t_max))
        t_vals[above] = float(t_max)

    df[t_col] = t_vals
    return n_violations


def _count_violations(df: pd.DataFrame, rules: List[Dict[str, Any]]) -> int:
    """Count total remaining violations across all rules."""
    total = 0
    for rule in rules:
        rtype = rule["type"]
        if rtype == "comparison":
            try:
                left_arr  = pd.to_numeric(df[rule["left"]],  errors="coerce").values
                right_arr = pd.to_numeric(df[rule["right"]], errors="coerce").values
                valid     = ~(np.isnan(left_arr) | np.isnan(right_arr))
                op_fn     = _OP_FUNCS[rule["op"]]
                total    += int((valid & ~op_fn(left_arr, right_arr)).sum())
            except Exception:
                pass
        elif rtype == "conditional":
            try:
                when = rule["when"]; then = rule["then"]
                mask  = df[when["column"]].astype(str) == str(when.get("equals"))
                t_arr = pd.to_numeric(df[then["column"]], errors="coerce").values
                t_min = then.get("min"); t_max = then.get("max")
                viol  = np.zeros(len(df), dtype=bool)
                if t_min is not None: viol |= mask.values & (t_arr < float(t_min))
                if t_max is not None: viol |= mask.values & (t_arr > float(t_max))
                total += int(viol.sum())
            except Exception:
                pass
    return total
