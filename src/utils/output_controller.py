"""
output_controller.py — Anti-Bypass Output Gate
================================================

THE ONLY AUTHORIZED EXIT for pipeline results.

RULE: No `return` in generate() is permitted except through
      OutputController.release(). Any other return is an anti-pattern
      that bypasses the enforcement chain.

Architecture
------------
    generate() builds pipeline_output dict
         │
         └─ OutputController.release(pipeline_output, ...)
                  │
                  ├─ export_guarded(cp, contract_result)   [blocks cp.export() before contract]
                  ├─ final_decision(contract, leakage, evaluation)  [single authority]
                  └─ return validated_output               [ONLY authorized return]

export_guarded
--------------
    Wraps cp.export() with a contract check.
    If the contract is not satisfied, raises PipelineHardFail.
    cp.export() is NEVER called before the contract passes.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pipeline_errors import PipelineHardFail
from final_decision import final_decision


# ==================================================================
# export_guarded — blocks cp.export() before contract is satisfied
# ==================================================================

def export_guarded(cp: Any, contract_result: Any) -> List[Dict[str, Any]]:
    """
    Call cp.export() only after verifying the contract is satisfied.

    Parameters
    ----------
    cp              : CheckPoint instance
    contract_result : ContractResult from PipelineContract.enforce()

    Returns
    -------
    List of validated row dicts.

    Raises
    ------
    PipelineHardFail if the contract is not satisfied.
    """
    if not getattr(contract_result, "is_valid", False):
        violations = getattr(contract_result, "violations", ["<unknown>"])
        raise PipelineHardFail(
            message = (
                f"EXPORT BLOCKED: Cannot export rows before pipeline contract "
                f"is satisfied. Violations: {'; '.join(violations)}"
            ),
            stage   = "export_guarded",
            context = {"contract_valid": False, "violations": violations},
        )
    return cp.export()


# ==================================================================
# OutputController — single authorized exit
# ==================================================================

class OutputController:
    """
    Single authorized exit point for all pipeline output.

    Usage
    -----
        result = OutputController.release(
            pipeline_output  = raw_output_dict,
            contract_result  = enforcer.enforce_contract(),
            leakage_passed   = leakage_ok,
            evaluation_result = evaluation,
        )
        return result   # THE ONLY return in generate()
    """

    @staticmethod
    def release(
        pipeline_output:   Dict[str, Any],
        contract_result:   Any,
        leakage_passed:    bool,
        evaluation_result: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Authorize and release pipeline output.

        This method is the ONLY allowed return path in generate().
        It calls final_decision() which raises if anything fails.
        If final_decision() does not raise, the output is clean.

        Parameters
        ----------
        pipeline_output   : the result dict built by generate()
        contract_result   : ContractResult (must have is_valid=True)
        leakage_passed    : True if leakage_gate did not raise
        evaluation_result : dict from evaluation_pipeline.evaluate()

        Returns
        -------
        pipeline_output unchanged — no mutation, no filtering.
        Caller receives exactly what was built.

        Raises
        ------
        PipelineHardFail if ANY enforcement check failed.
        """
        # This is the ONLY call to final_decision in the entire codebase.
        final_decision(
            contract_result   = contract_result,
            leakage_passed    = leakage_passed,
            evaluation_result = evaluation_result,
            stage             = "output_controller",
        )

        # Stamp the output with a release marker so the extension can verify
        # the output passed the full chain.
        pipeline_output["_released"] = True
        pipeline_output["_release_stage"] = "OutputController.release"

        return pipeline_output
