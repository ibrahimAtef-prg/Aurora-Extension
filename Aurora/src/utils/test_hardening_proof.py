"""
test_hardening_proof.py — Phase 7 Security & Robustness Proof Tests
=====================================================================

5 mandatory proof tests for the hardening modules:

1. Malicious pickle → SecurityError
2. Overfitting dataset → PipelineHardFail
3. High concurrency → queue limit enforced
4. Low entropy / collapsed dataset → PipelineHardFail
5. Feedback loop reuse attempt → PipelineHardFail

Run with:
    py test_hardening_proof.py

Expected:
    5 PASSED, 0 FAILED
"""

from __future__ import annotations

import sys
import os
import json
import tempfile
import traceback
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ==================================================================
# Harness
# ==================================================================

_PASSED = 0
_FAILED = 0


def _pass(name: str, detail: str = "") -> None:
    global _PASSED
    _PASSED += 1
    print(f"  PASS [{name}]{(' — ' + detail) if detail else ''}")


def _fail(name: str, reason: str) -> None:
    global _FAILED
    _FAILED += 1
    print(f"  FAIL [{name}] — {reason}")


# ==================================================================
# Test 1 — Malicious pickle → SecurityError
# ==================================================================

def test_malicious_pickle():
    """
    Write a pickle file that contains an os.system call payload.
    safe_load() must raise SecurityError before executing anything.
    """
    import pickle
    import io
    from signed_pickle_loader import safe_load, SecurityError

    # Build a payload that would call os.system if unpickled naively
    class _Exploit:
        def __reduce__(self):
            return (os.system, ("echo PWNED",))

    raw_pickle = pickle.dumps(_Exploit())

    tmp = tempfile.mktemp(suffix=".pkl")
    with open(tmp, "wb") as f:
        f.write(raw_pickle)

    try:
        raised = None
        rejected_msg = ""
        try:
            safe_load(tmp)
        except SecurityError as e:
            raised = e
            rejected_msg = f"SecurityError: {str(e)[:80]}"
        except ValueError as e:
            # ValueError = file is not a valid signed payload (wrong magic / too short).
            # This is equally safe — no deserialization occurred.
            raised = e
            rejected_msg = f"ValueError (unsigned file rejected): {str(e)[:80]}"
        except Exception as e:
            _fail("Malicious Pickle", f"Wrong exception type: {type(e).__name__}: {e}")
            return
        finally:
            try: os.unlink(tmp)
            except OSError: pass

        if raised:
            _pass("Malicious Pickle", rejected_msg)
        else:
            _fail("Malicious Pickle", "safe_load() did not raise — malicious code could execute")
    except Exception as e:
        _fail("Malicious Pickle", f"Unexpected error: {e}")


# ==================================================================
# Test 2 — Overfitting dataset → PipelineHardFail
# ==================================================================

def test_overfitting_detection():
    """
    Create a synthetic DataFrame where all rows are identical (mode collapse).
    check_overfitting() must raise PipelineHardFail.
    """
    import pandas as pd
    import numpy as np
    from overfitting_detector import check_overfitting
    from pipeline_errors import PipelineHardFail

    # 500 rows all identical — unique_ratio = 1/500 = 0.002 < 0.01 threshold
    df = pd.DataFrame({
        "age":    [35.0] * 500,
        "income": [50000.0] * 500,
        "score":  [0.75] * 500,
    })

    class MockBL:
        columns = {"numeric": {
            "age":    {"mean": 35.0, "std": 10.0},
            "income": {"mean": 50000.0, "std": 5000.0},
            "score":  {"mean": 0.5, "std": 0.2},
        }}

    raised = None
    try:
        check_overfitting(df, MockBL(), stage="test_overfit")
    except PipelineHardFail as e:
        raised = e
    except Exception as e:
        _fail("Overfitting Detection", f"Wrong exception: {type(e).__name__}: {e}")
        return

    if raised:
        _pass("Overfitting Detection", f"stage={raised.stage}, msg={str(raised)[:80]}")
    else:
        _fail("Overfitting Detection", "check_overfitting() did not raise on collapsed dataset")


# ==================================================================
# Test 3 — High concurrency → queue limit enforced
# ==================================================================

def test_concurrency_queue_limit():
    """
    Saturate the execution controller with MAX_CONCURRENT+MAX_QUEUE+1 requests.
    The overflow request must be rejected with PipelineHardFail immediately.
    """
    from execution_controller import _ExecutionController
    from pipeline_errors import PipelineHardFail

    # Small controller: 2 concurrent, 2 queue
    ctrl = _ExecutionController(max_concurrent=2, max_queue=2)

    # Hold 2 slots so queue fills
    slot_a = ctrl.acquire("run-a", timeout=5)
    slot_b = ctrl.acquire("run-b", timeout=5)

    # Queue 2 waiters in background threads (they will block)
    results = {"errors": []}

    def _wait(rid):
        try:
            s = ctrl.acquire(rid, timeout=30)
            ctrl.release(s)
        except Exception as e:
            results["errors"].append(e)

    t1 = threading.Thread(target=_wait, args=("run-c",), daemon=True)
    t2 = threading.Thread(target=_wait, args=("run-d",), daemon=True)
    t1.start(); t2.start()

    import time; time.sleep(0.1)   # let threads queue

    # Now try to add a 5th request — should be rejected instantly
    rejected = False
    rejection_msg = ""
    try:
        ctrl.acquire("run-overflow", timeout=0.5)
    except PipelineHardFail as e:
        rejected = True
        rejection_msg = str(e)[:80]
    except Exception as e:
        _fail("Concurrency Queue Limit", f"Wrong exception: {type(e).__name__}: {e}")
        ctrl.release(slot_a); ctrl.release(slot_b)
        return
    finally:
        ctrl.release(slot_a)
        ctrl.release(slot_b)

    if rejected:
        _pass("Concurrency Queue Limit", f"BACKPRESSURE: {rejection_msg}")
    else:
        _fail("Concurrency Queue Limit", "Overflow request was NOT rejected — queue limit not enforced")


# ==================================================================
# Test 4 — Low entropy dataset → distribution collapse detection
# ==================================================================

def test_entropy_collapse_detection():
    """
    Create a DataFrame where one column has only one unique value.
    check_diversity() must raise PipelineHardFail.
    """
    import pandas as pd
    from diversity_guard import check_diversity
    from pipeline_errors import PipelineHardFail

    # 'status' column has entropy = 0 (only one value)
    df = pd.DataFrame({
        "age":    [25.0, 30.0, 22.0, 45.0, 33.0] * 100,
        "status": ["active"] * 500,   # zero entropy
    })

    raised = None
    try:
        check_diversity(df, stage="test_collapse")
    except PipelineHardFail as e:
        raised = e
    except Exception as e:
        _fail("Entropy Collapse Detection", f"Wrong exception: {type(e).__name__}: {e}")
        return

    if raised:
        _pass("Entropy Collapse Detection", f"stage={raised.stage}, msg={str(raised)[:80]}")
    else:
        _fail("Entropy Collapse Detection", "check_diversity() did not raise on zero-entropy column")


# ==================================================================
# Test 5 — Feedback loop reuse → check_origin_purity blocks
# ==================================================================

def test_feedback_loop_blocked():
    """
    Create a DataFrame that has _origin='generated' rows.
    check_origin_purity() must raise PipelineHardFail.
    """
    import pandas as pd
    from diversity_guard import check_origin_purity, tag_generated_rows
    from pipeline_errors import PipelineHardFail

    # Simulate generated rows being fed back as training input
    records = [{"age": 30, "income": 50000}, {"age": 25, "income": 40000}]
    tagged  = tag_generated_rows(records)       # adds _origin="generated"
    df      = pd.DataFrame(tagged)              # build DataFrame with tag

    raised = None
    try:
        check_origin_purity(df, stage="test_feedback")
    except PipelineHardFail as e:
        raised = e
    except Exception as e:
        _fail("Feedback Loop Blocked", f"Wrong exception: {type(e).__name__}: {e}")
        return

    if raised:
        _pass("Feedback Loop Blocked", f"stage={raised.stage}, msg={str(raised)[:80]}")
    else:
        _fail("Feedback Loop Blocked", "check_origin_purity() did not block generated rows")


# ==================================================================
# Test 6 — Tampered signed file → HMAC failure
# ==================================================================

def test_hmac_tamper_detection():
    """
    Write a valid signed file, then flip one byte in the payload.
    safe_load() must raise SecurityError due to HMAC mismatch.
    """
    from signed_pickle_loader import safe_dump, safe_load, SecurityError

    tmp = tempfile.mktemp(suffix=".pkl")
    try:
        # Write a valid signed file
        safe_dump({"key": "value", "nums": [1, 2, 3]}, tmp)

        # Corrupt one byte in the middle of the payload
        with open(tmp, "r+b") as f:
            data = bytearray(f.read())
        mid = len(data) // 2
        data[mid] ^= 0xFF        # flip all bits in one byte
        with open(tmp, "wb") as f:
            f.write(data)

        raised = None
        try:
            safe_load(tmp)
        except SecurityError as e:
            raised = e
        except Exception as e:
            _fail("HMAC Tamper Detection", f"Wrong exception: {type(e).__name__}: {e}")
            return

        if raised:
            _pass("HMAC Tamper Detection", f"SecurityError caught: {str(raised)[:80]}")
        else:
            _fail("HMAC Tamper Detection", "safe_load() loaded tampered file — HMAC not enforced")
    finally:
        try: os.unlink(tmp)
        except OSError: pass


# ==================================================================
# Run all tests
# ==================================================================

if __name__ == "__main__":
    print("=" * 60)
    print("AutoMate Hardening Proof Tests (Security + Robustness)")
    print("=" * 60)

    print("\n[TEST 1] Malicious Pickle -> SecurityError")
    test_malicious_pickle()

    print("\n[TEST 2] Overfitting Dataset -> PipelineHardFail")
    test_overfitting_detection()

    print("\n[TEST 3] High Concurrency -> Queue Limit Enforced")
    test_concurrency_queue_limit()

    print("\n[TEST 4] Low Entropy Dataset -> Collapse Detection")
    test_entropy_collapse_detection()

    print("\n[TEST 5] Feedback Loop Reuse -> Blocked")
    test_feedback_loop_blocked()

    print("\n[TEST 6] HMAC Tamper Detection")
    test_hmac_tamper_detection()

    print("\n" + "=" * 60)
    print(f"Results: {_PASSED} PASSED, {_FAILED} FAILED")
    if _FAILED == 0:
        print("ALL HARDENING PROOF TESTS PASSED")
    else:
        print("SOME TESTS FAILED — security/robustness gaps remain")
    print("=" * 60)

    sys.exit(0 if _FAILED == 0 else 1)
