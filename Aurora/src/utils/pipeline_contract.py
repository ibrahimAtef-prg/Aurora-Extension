"""
pipeline_contract.py — Pipeline Success Contract
=================================================

Defines the formal contract that a pipeline run MUST satisfy before its
result is considered valid.  This is the FINAL gate that runs after all
other enforcement checks.

Contract clauses
----------------
1. INVARIANTS_PASSED   — system_invariants ran and found no violations
2. METRICS_VALID       — metric_gate ran and no threshold was exceeded
3. NO_CONTRADICTIONS   — sanity_guard found no impossible combinations
4. ROW_COUNT_MET       — actual rows ≥ requested (or ≥ minimum fraction)
5. SEED_RECORDED       — seed was captured in audit log (determinism)
6. CONFIG_HASH_PRESENT — config snapshot was created (reproducibility)

If ANY clause fails → result.is_valid == False and result.error is set.
The pipeline MUST NOT return output when result.is_valid is False.

Usage
-----
    contract = PipelineContract(
        n_requested      = 500,
        min_row_fraction = 0.95,   # at least 475 rows
    )

    # add evidence as pipeline runs
    contract.record_invariants_passed()
    contract.record_metrics_valid(metrics_dict)
    contract.record_sanity_passed()
    contract.record_rows(actual=480)
    contract.record_seed(42)
    contract.record_config_hash("abc123")

    result = contract.evaluate()
    if not result.is_valid:
        raise PipelineHardFail(result.error, stage="contract")
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from pipeline_errors import PipelineHardFail


# ==================================================================
# Contract result
# ==================================================================

@dataclass
class ContractResult:
    is_valid:       bool
    clauses:        Dict[str, bool]    = field(default_factory=dict)
    violations:     List[str]          = field(default_factory=list)
    error:          Optional[str]      = None
    metrics_seen:   Dict[str, Any]     = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "is_valid":     self.is_valid,
            "clauses":      self.clauses,
            "violations":   self.violations,
            "error":        self.error,
        }


# ==================================================================
# Contract
# ==================================================================

class PipelineContract:
    """
    Stateful contract accumulator for one pipeline run.

    Call record_* methods as each enforcement step completes.
    Call evaluate() at the very end to get the ContractResult.
    """

    def __init__(
        self,
        n_requested:       int,
        min_row_fraction:  float = 1.0,    # 1.0 = must hit exactly
    ) -> None:
        self._n_requested       = n_requested
        self._min_row_fraction  = max(0.0, min(1.0, min_row_fraction))
        self._min_rows          = max(1, int(n_requested * self._min_row_fraction))

        # Clause evidence
        self._invariants_passed   = False
        self._metrics_valid       = False
        self._sane                = False
        self._actual_rows:  Optional[int] = None
        self._seed:         Optional[int] = None
        self._config_hash:  Optional[str] = None
        self._metrics_seen: Dict[str, Any] = {}
        self._extra_violations: List[str] = []

    # ------------------------------------------------------------------
    # Evidence recording
    # ------------------------------------------------------------------

    def record_invariants_passed(self) -> None:
        """Call after system_invariants.check_dataframe() succeeds."""
        self._invariants_passed = True

    def record_metrics_valid(self, metrics: Dict[str, Any]) -> None:
        """Call after metric_gate.enforce_all() succeeds."""
        self._metrics_valid = True
        self._metrics_seen.update(metrics)

    def record_sanity_passed(self) -> None:
        """Call after sanity_guard.check_dataframe() and check_metrics() succeed."""
        self._sane = True

    def record_rows(self, actual: int) -> None:
        """Call with the actual number of rows generated."""
        self._actual_rows = actual

    def record_seed(self, seed: int) -> None:
        """Call after seed_manager.init() resolves and logs the seed."""
        self._seed = seed

    def record_config_hash(self, config_hash: str) -> None:
        """Call after config_snapshot.create() succeeds."""
        self._config_hash = config_hash

    def add_violation(self, message: str) -> None:
        """Manually add a violation (for custom checks outside standard flow)."""
        self._extra_violations.append(message)

    # ------------------------------------------------------------------
    # Evaluation
    # ------------------------------------------------------------------

    def evaluate(self) -> ContractResult:
        """
        Evaluate all clauses and return a ContractResult.
        Does NOT raise — the caller is responsible for acting on is_valid.
        """
        clauses:    Dict[str, bool] = {}
        violations: List[str]       = []

        # Clause 1: invariants passed
        clauses["INVARIANTS_PASSED"] = self._invariants_passed
        if not self._invariants_passed:
            violations.append(
                "INVARIANTS_PASSED: record_invariants_passed() was never called — "
                "system_invariants check may have been skipped"
            )

        # Clause 2: metrics valid
        clauses["METRICS_VALID"] = self._metrics_valid
        if not self._metrics_valid:
            violations.append(
                "METRICS_VALID: record_metrics_valid() was never called — "
                "metric_gate check may have been skipped"
            )

        # Clause 3: sanity guard
        clauses["NO_CONTRADICTIONS"] = self._sane
        if not self._sane:
            violations.append(
                "NO_CONTRADICTIONS: record_sanity_passed() was never called — "
                "sanity_guard check may have been skipped"
            )

        # Clause 4: row count
        row_ok = (
            self._actual_rows is not None and
            self._actual_rows >= self._min_rows
        )
        clauses["ROW_COUNT_MET"] = row_ok
        if not row_ok:
            actual_str = str(self._actual_rows) if self._actual_rows is not None else "unknown"
            violations.append(
                f"ROW_COUNT_MET: got {actual_str} rows, "
                f"need ≥ {self._min_rows} "
                f"({self._min_row_fraction:.0%} of {self._n_requested} requested)"
            )

        # Clause 5: seed recorded
        seed_ok = self._seed is not None
        clauses["SEED_RECORDED"] = seed_ok
        if not seed_ok:
            violations.append(
                "SEED_RECORDED: seed was not recorded — "
                "run is not reproducible"
            )

        # Clause 6: config hash present
        cfg_ok = bool(self._config_hash)
        clauses["CONFIG_HASH_PRESENT"] = cfg_ok
        if not cfg_ok:
            violations.append(
                "CONFIG_HASH_PRESENT: config snapshot was not created — "
                "run is not reproducible"
            )

        # Extra manually added violations
        violations.extend(self._extra_violations)

        is_valid = len(violations) == 0
        error    = "; ".join(violations) if violations else None

        return ContractResult(
            is_valid     = is_valid,
            clauses      = clauses,
            violations   = violations,
            error        = error,
            metrics_seen = dict(self._metrics_seen),
        )

    def enforce(self) -> ContractResult:
        """
        Evaluate the contract and raise PipelineHardFail if not satisfied.
        Use this as the final gate in generate().

        Returns ContractResult on success.
        """
        result = self.evaluate()
        if not result.is_valid:
            raise PipelineHardFail(
                message = f"Pipeline contract violated: {result.error}",
                stage   = "pipeline_contract",
                context = result.to_dict(),
            )
        return result
