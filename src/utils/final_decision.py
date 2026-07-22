"""
final_decision.py — Single Authority Final Decision Point
==========================================================

THE ONLY PLACE where the pipeline decides whether output is releasable.

Called as the very last step before OutputController.release().
Aggregates all enforcement results and raises PipelineHardFail
if ANY of them indicate failure.

Rules
-----
    1. contract.is_valid must be True
    2. leakage_passed must be True
    3. evaluation_verdict must be "PASS" or "WARN"
       ("FAIL" or "ERROR" → hard fail)

NO WARNINGS PASS silently. If evaluation verdict is "WARN",
the warnings are recorded but output is NOT blocked — this is
the only deliberately permissive path and is documented explicitly.
Everything else raises.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pipeline_errors import PipelineHardFail


# ==================================================================
# Public API
# ==================================================================

def final_decision(
    contract_result:     Any,    # ContractResult from pipeline_contract
    leakage_passed:      bool,
    evaluation_result:   Dict[str, Any],
    stage:               str = "final_decision",
) -> None:
    """
    Single authority gate. Raises PipelineHardFail if output is not releasable.

    Parameters
    ----------
    contract_result   : ContractResult from PipelineContract.enforce()
    leakage_passed    : True if leakage_gate.enforce_leakage() did not raise
    evaluation_result : dict from evaluation_pipeline.evaluate()
    stage             : stage label for error context

    Raises
    ------
    PipelineHardFail if ANY condition fails.
    Returns None if all conditions pass.
    """
    failures: List[str] = []

    # ── 1. Contract ───────────────────────────────────────────────
    if not getattr(contract_result, "is_valid", False):
        violations = getattr(contract_result, "violations", [])
        raise PipelineHardFail(
            message = (
                f"FINAL DECISION BLOCKED: Pipeline contract not satisfied. "
                f"Violations: {'; '.join(violations)}"
            ),
            stage   = stage,
            context = {"contract": contract_result.to_dict() if hasattr(contract_result, "to_dict") else {}},
        )

    # ── 2. Leakage gate ──────────────────────────────────────────
    if not leakage_passed:
        # leakage_gate.enforce_leakage() already raised; this is the
        # belt-and-suspenders check if caller caught and re-evaluated.
        raise PipelineHardFail(
            message = "FINAL DECISION BLOCKED: Leakage gate did not pass.",
            stage   = stage,
        )

    # ── 3. Evaluation ────────────────────────────────────────────
    verdict = evaluation_result.get("verdict", "ERROR")

    if verdict == "FAIL":
        errors = evaluation_result.get("errors", [])
        raise PipelineHardFail(
            message = (
                f"FINAL DECISION BLOCKED: Independent evaluation verdict=FAIL. "
                f"Errors: {'; '.join(errors)}"
            ),
            stage   = stage,
            context = {"evaluation": evaluation_result},
        )

    if verdict == "ERROR":
        error_msg = evaluation_result.get("error", "unknown error")
        raise PipelineHardFail(
            message = (
                f"FINAL DECISION BLOCKED: Independent evaluation failed with error: "
                f"{error_msg}. Cannot release output without evaluation confirmation."
            ),
            stage   = stage,
            context = {"evaluation": evaluation_result},
        )

    # verdict == "PASS" or "WARN" — only acceptable states
    # "WARN" is explicitly permissive: warnings are informational,
    # not blocking. This is the ONLY non-raising path.
