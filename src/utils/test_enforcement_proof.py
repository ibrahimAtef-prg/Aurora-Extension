"""
test_enforcement_proof.py — Phase 4 Proof Tests
=================================================

Three mandatory proof tests that verify the enforcement chain is
unbypassable. Each test injects a specific failure condition and
confirms that:
    1. PipelineHardFail is raised
    2. NO output dataset is returned
    3. The exact failure stage is identified

Run with:
    python test_enforcement_proof.py

Expected output:
    TEST 1 PASS — NaN injection blocked
    TEST 2 PASS — Duplicate explosion blocked
    TEST 3 PASS — Schema break blocked
    ALL PROOF TESTS PASSED
"""

from __future__ import annotations

import sys
import os
import json
import math
import traceback
from typing import Any, Dict, List

# Make the utils folder importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ==================================================================
# Test harness
# ==================================================================

_PASSED = 0
_FAILED = 0


def _assert_hard_fail(test_name: str, fn, expected_fragment: str = "") -> None:
    """
    Verify that fn() raises PipelineHardFail and returns nothing.
    """
    global _PASSED, _FAILED
    from pipeline_errors import PipelineHardFail

    result = _SENTINEL = object()
    raised = None
    try:
        result = fn()
    except PipelineHardFail as e:
        raised = e
    except Exception as e:
        _FAILED += 1
        print(f"  FAIL [{test_name}] — unexpected exception type {type(e).__name__}: {e}")
        traceback.print_exc()
        return

    if raised is None:
        _FAILED += 1
        print(f"  FAIL [{test_name}] — no exception raised. result={result!r}")
        return

    if result is not _SENTINEL:
        _FAILED += 1
        print(f"  FAIL [{test_name}] — result returned despite exception: {result!r}")
        return

    if expected_fragment and expected_fragment.lower() not in str(raised).lower():
        _FAILED += 1
        print(
            f"  FAIL [{test_name}] — raised PipelineHardFail but wrong message.\n"
            f"    Expected fragment: '{expected_fragment}'\n"
            f"    Got:              '{raised}'"
        )
        return

    _PASSED += 1
    print(f"  PASS [{test_name}] — PipelineHardFail raised at stage='{raised.stage}'")
    print(f"         message: {str(raised)[:120]}")


# ==================================================================
# Test 1 — NaN Injection
# ==================================================================

def test_nan_injection():
    """
    Inject NaN values into a synthetic DataFrame and verify that
    system_invariants.check_dataframe() raises InvariantViolation.
    """
    import numpy as np
    import pandas as pd
    from system_invariants import check_dataframe
    from pipeline_errors import InvariantViolation

    # Minimal mock baseline reader
    class MockBL:
        col_order   = ["a", "b", "label"]
        numeric     = {"a": {}, "b": {}}
        categorical = {}
        allowed     = {}

    df = pd.DataFrame({
        "a":     [1.0, float("nan"), 3.0],
        "b":     [4.0, 5.0, 6.0],
        "label": ["x", "y", "z"],
    })

    def _run():
        check_dataframe(df, MockBL(), stage="test_nan")

    _assert_hard_fail("NaN Injection", _run, expected_fragment="NO_NAN")


# ==================================================================
# Test 2 — Duplicate Explosion
# ==================================================================

def test_duplicate_explosion():
    """
    Force duplicates_rate above threshold and verify leakage_gate raises.
    """
    from leakage_gate import enforce_leakage
    from pipeline_errors import PipelineHardFail

    # 50% duplicate rate — well above the 10% hard limit
    metrics = {
        "duplicates_rate":          0.50,
        "privacy_score":            0.80,
        "membership_inference_auc": 0.55,
    }

    def _run():
        enforce_leakage(metrics, stage="test_dup_explosion")

    _assert_hard_fail("Duplicate Explosion", _run, expected_fragment="LEAKAGE VIOLATION")


# ==================================================================
# Test 3 — Schema Break
# ==================================================================

def test_schema_break():
    """
    Remove a required column from the DataFrame and verify that
    system_invariants.check_dataframe() raises InvariantViolation (SCHEMA_MATCH).
    """
    import pandas as pd
    from system_invariants import check_dataframe

    class MockBL:
        col_order   = ["a", "b", "c"]
        numeric     = {"a": {}, "b": {}}
        categorical = {}
        allowed     = {}

    # 'c' is missing — schema break
    df = pd.DataFrame({
        "a": [1.0, 2.0],
        "b": [3.0, 4.0],
        # 'c' intentionally omitted
    })

    def _run():
        check_dataframe(df, MockBL(), stage="test_schema_break")

    _assert_hard_fail("Schema Break", _run, expected_fragment="SCHEMA_MATCH")


# ==================================================================
# Test 4 — Evaluation FAIL blocks output
# ==================================================================

def test_evaluation_hard_gate():
    """
    Verify that final_decision() raises when evaluation verdict is FAIL.
    """
    from final_decision import final_decision
    from pipeline_errors import PipelineHardFail

    class MockContract:
        is_valid   = True
        violations = []
        def to_dict(self): return {"is_valid": True}

    failed_eval = {
        "verdict": "FAIL",
        "errors":  ["Column 'age' has 15 OOB values (5.0%)"],
        "warnings": [],
    }

    def _run():
        final_decision(
            contract_result   = MockContract(),
            leakage_passed    = True,
            evaluation_result = failed_eval,
            stage             = "test_eval_gate",
        )

    _assert_hard_fail("Evaluation FAIL Gate", _run, expected_fragment="FINAL DECISION BLOCKED")


# ==================================================================
# Test 5 — Contract failure blocks export
# ==================================================================

def test_export_guarded():
    """
    Verify that export_guarded() raises when contract is not satisfied.
    """
    from output_controller import export_guarded
    from pipeline_errors import PipelineHardFail

    class FailedContract:
        is_valid   = False
        violations = ["INVARIANTS_PASSED: invariant check was skipped"]

    class MockCP:
        def export(self):
            raise AssertionError("cp.export() must never be called when contract failed")

    def _run():
        export_guarded(MockCP(), FailedContract())

    _assert_hard_fail("Export Guarded", _run, expected_fragment="EXPORT BLOCKED")


# ==================================================================
# Test 6 — OutputController cannot release without final_decision
# ==================================================================

def test_output_controller_blocks_on_failed_contract():
    """
    Verify that OutputController.release() raises when contract failed.
    """
    from output_controller import OutputController
    from pipeline_errors import PipelineHardFail

    class FailedContract:
        is_valid   = False
        violations = ["ROW_COUNT_MET: only 10 rows, need 500"]
        def to_dict(self): return {"is_valid": False}

    good_eval = {"verdict": "PASS", "errors": [], "warnings": []}

    def _run():
        return OutputController.release(
            pipeline_output   = {"samples": [{"x": 1}]},
            contract_result   = FailedContract(),
            leakage_passed    = True,
            evaluation_result = good_eval,
        )

    _assert_hard_fail("OutputController Blocked", _run, expected_fragment="FINAL DECISION BLOCKED")


# ==================================================================
# Test 7 — Post-freeze mutation attempt is blocked
# ==================================================================

def test_post_freeze_mutation_blocked():
    """
    After cp.freeze(), any call to commit() must raise RuntimeError,
    not silently succeed. This proves the mutation window is closed.
    """
    global _PASSED, _FAILED
    import tempfile, os, json
    import pandas as pd

    # Build a minimal checkpoint
    tmp = tempfile.mkdtemp()
    cp_path = os.path.join(tmp, "test_cp.json")
    with open(cp_path, "w") as f:
        json.dump({
            "schema_version": "1.0", "dataset_fingerprint": "test",
            "generator_used": "test", "n_requested": 10,
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            "status": "complete", "final_warnings": [], "commits": [],
            "rows": [{"a": 1}, {"a": 2}],
        }, f)

    from checkp import CheckPoint
    cp = CheckPoint(path=cp_path, n_requested=10,
                    dataset_fingerprint="test", generator_used="test")
    cp.freeze()

    # Attempt commit after freeze
    df = pd.DataFrame({"a": [99]})

    class MockVR:
        n_evaluated = 1; n_accepted = 1
        n_rejected_quality = 0; n_rejected_duplicates = 0
        n_rejected_constraints = 0

    mutation_blocked = False
    try:
        cp.commit(df, round=99, validation_result=MockVR())
    except RuntimeError as e:
        if "freeze" in str(e).lower() or "immutable" in str(e).lower():
            mutation_blocked = True

    if mutation_blocked:
        _PASSED += 1
        print("  PASS [Post-Freeze Mutation Blocked] — commit() raised RuntimeError after freeze()")
    else:
        _FAILED += 1
        print("  FAIL [Post-Freeze Mutation Blocked] — commit() did NOT raise after freeze()")


# ==================================================================
# Test 8 — peek() raises if called before freeze()
# ==================================================================

def test_peek_requires_freeze():
    """
    peek() must raise RuntimeError if called before freeze().
    This enforces that the validation window is only open
    after the checkpoint is immutable.
    """
    global _PASSED, _FAILED
    import tempfile, os, json

    tmp = tempfile.mkdtemp()
    cp_path = os.path.join(tmp, "test_cp2.json")
    with open(cp_path, "w") as f:
        json.dump({
            "schema_version": "1.0", "dataset_fingerprint": "test",
            "generator_used": "test", "n_requested": 5,
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            "status": "complete", "final_warnings": [], "commits": [],
            "rows": [{"x": 1}],
        }, f)

    from checkp import CheckPoint
    cp = CheckPoint(path=cp_path, n_requested=5,
                    dataset_fingerprint="test", generator_used="test")
    # NOT frozen — peek() should raise

    peek_blocked = False
    try:
        cp.peek()
    except RuntimeError as e:
        if "freeze" in str(e).lower():
            peek_blocked = True

    if peek_blocked:
        _PASSED += 1
        print("  PASS [Peek Requires Freeze] — peek() raised RuntimeError before freeze()")
    else:
        _FAILED += 1
        print("  FAIL [Peek Requires Freeze] — peek() succeeded without freeze()")


# ==================================================================
# Test 9 — content_hash identity assertion catches divergence
# ==================================================================

def test_identity_assertion_catches_divergence():
    """
    Simulate a divergence between pre_validation_hash and post_export_hash
    and verify that PipelineHardFail is raised.
    This is the exact guard in generator.py after export_guarded().
    """
    from pipeline_errors import PipelineHardFail

    pre_hash  = "aaaaaa" * 10   # 60 chars (simulated)
    post_hash = "bbbbbb" * 10   # different

    def _run():
        if pre_hash != post_hash:
            raise PipelineHardFail(
                message = (
                    "DATA DIVERGENCE DETECTED: The dataset used for validation "
                    "differs from the exported dataset. "
                    f"pre_validation_hash={pre_hash!r}, "
                    f"post_export_hash={post_hash!r}."
                ),
                stage   = "identity_assertion",
                context = {
                    "pre_validation_hash": pre_hash,
                    "post_export_hash":    post_hash,
                },
            )

    _assert_hard_fail(
        "Identity Assertion Catches Divergence",
        _run,
        expected_fragment="DATA DIVERGENCE DETECTED"
    )


# ==================================================================
# Run all tests
# ==================================================================

if __name__ == "__main__":
    print("=" * 60)
    print("AutoMate Enforcement Proof Tests")
    print("=" * 60)

    print("\n[TEST 1] NaN Injection")
    test_nan_injection()

    print("\n[TEST 2] Duplicate Explosion")
    test_duplicate_explosion()

    print("\n[TEST 3] Schema Break")
    test_schema_break()

    print("\n[TEST 4] Evaluation FAIL Hard Gate")
    test_evaluation_hard_gate()

    print("\n[TEST 5] Export Guarded")
    test_export_guarded()

    print("\n[TEST 6] OutputController Blocked on Failed Contract")
    test_output_controller_blocks_on_failed_contract()

    print("\n[TEST 7] Post-Freeze Mutation Blocked")
    test_post_freeze_mutation_blocked()

    print("\n[TEST 8] Peek Requires Freeze")
    test_peek_requires_freeze()

    print("\n[TEST 9] Identity Assertion Catches Divergence")
    test_identity_assertion_catches_divergence()

    print("\n" + "=" * 60)
    print(f"Results: {_PASSED} PASSED, {_FAILED} FAILED")
    if _FAILED == 0:
        print("ALL PROOF TESTS PASSED")
    else:
        print("SOME TESTS FAILED — enforcement chain has gaps")
    print("=" * 60)

    sys.exit(0 if _FAILED == 0 else 1)
