"""
signed_pickle_loader.py — Secure Pickle I/O with HMAC Signing
=============================================================

Replaces all raw pickle.load() / pickle.dump() calls in the codebase.

Security properties
-------------------
1. HMAC-SHA256 signature on every written file.
2. Signature verified before any unpickling — tampered files are rejected.
3. RestrictedUnpickler blocks all dangerous global lookups — only a
   whitelisted set of numpy/builtins types can be unpickled.
4. Key derivation: HMAC key is derived from a per-run secret stored in
   an environment variable (AUTOMATE_CACHE_KEY) or a generated per-process
   fallback written to a locked key file in the cache dir.

Usage
-----
    from signed_pickle_loader import safe_dump, safe_load

    safe_dump(payload, path)             # replaces: pickle.dump(payload, f)
    obj = safe_load(path)                # replaces: pickle.load(f)

Any tampered or unsigned file raises SecurityError.
Any file containing disallowed types raises SecurityError.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import os
import pickle
import stat
import struct
import tempfile
from typing import Any


# ==================================================================
# Exceptions
# ==================================================================

class SecurityError(Exception):
    """Raised on HMAC verification failure or disallowed type in pickle."""


# ==================================================================
# Whitelist — the ONLY types allowed to be unpickled
# ==================================================================

_ALLOWED_GLOBALS: dict[str, set[str]] = {
    "numpy":            {"ndarray", "dtype", "float64", "float32", "int64",
                         "int32", "bool_", "str_", "object_"},
    "numpy.core.multiarray": {"_reconstruct", "scalar"},
    "builtins":         {"list", "dict", "tuple", "set", "frozenset",
                         "str", "int", "float", "bool", "bytes",
                         "bytearray", "type", "NoneType"},
    "_codecs":          {"encode"},
}


class _RestrictedUnpickler(pickle.Unpickler):
    """
    Unpickler that whitelists allowed modules and class names.
    Any attempt to load a disallowed global raises SecurityError immediately.
    """

    def find_class(self, module: str, name: str) -> Any:
        allowed_names = _ALLOWED_GLOBALS.get(module)
        if allowed_names is None or name not in allowed_names:
            raise SecurityError(
                f"SECURITY: Blocked disallowed pickle global "
                f"'{module}.{name}'. This indicates a tampered cache file "
                f"attempting restricted class injection."
            )
        return super().find_class(module, name)


# ==================================================================
# HMAC key management
# ==================================================================

_KEY_ENV_VAR  = "AUTOMATE_CACHE_KEY"
_KEY_FILENAME = ".cache_hmac_key"
_SIG_LENGTH   = 32          # HMAC-SHA256 = 32 bytes
_MAGIC        = b"AMSCP1\x00"  # AutoMate Signed Cache Payload v1


def _get_or_create_key(cache_dir: str | None = None) -> bytes:
    """
    Load or generate the HMAC key.

    Priority:
    1. AUTOMATE_CACHE_KEY env var (hex-encoded, min 32 hex chars = 16 bytes)
    2. Key file in cache_dir (auto-created with restricted permissions)
    3. In-process fallback (not persistent — cache miss on next run, safe)
    """
    env_key = os.environ.get(_KEY_ENV_VAR, "")
    if env_key and len(env_key) >= 32:
        try:
            return bytes.fromhex(env_key)
        except ValueError:
            pass   # bad hex — fall through

    if cache_dir:
        key_path = os.path.join(cache_dir, _KEY_FILENAME)
        if os.path.exists(key_path):
            try:
                with open(key_path, "rb") as f:
                    key = f.read()
                if len(key) >= 16:
                    return key
            except OSError:
                pass
        # Generate and persist
        key = os.urandom(32)
        try:
            fd, tmp = tempfile.mkstemp(dir=cache_dir)
            with os.fdopen(fd, "wb") as f:
                f.write(key)
            os.replace(tmp, key_path)
            # Restrict permissions: owner-read only (unix)
            try:
                os.chmod(key_path, stat.S_IRUSR | stat.S_IWUSR)
            except (OSError, NotImplementedError):
                pass
            return key
        except OSError:
            pass

    # In-process fallback
    return os.urandom(32)


def _compute_hmac(data: bytes, key: bytes) -> bytes:
    """Compute HMAC-SHA256 of data using key."""
    return hmac.new(key, data, hashlib.sha256).digest()


# ==================================================================
# Public API
# ==================================================================

def safe_dump(obj: Any, path: str, cache_dir: str | None = None) -> None:
    """
    Serialize obj to path using pickle + HMAC-SHA256 signature.

    File format:
        MAGIC (7 bytes)
        payload_length (8 bytes, big-endian uint64)
        payload (pickle bytes)
        HMAC-SHA256 (32 bytes)

    Writes atomically (temp file + os.replace).

    Parameters
    ----------
    obj       : any picklable object (must only contain allowed types)
    path      : destination file path
    cache_dir : directory to look up/create the HMAC key file
    """
    key = _get_or_create_key(cache_dir or os.path.dirname(path) or ".")

    payload = pickle.dumps(obj, protocol=4)
    sig     = _compute_hmac(payload, key)
    length  = struct.pack(">Q", len(payload))

    raw = _MAGIC + length + payload + sig

    dir_path = os.path.dirname(path) or "."
    fd, tmp  = tempfile.mkstemp(dir=dir_path, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def safe_load(path: str, cache_dir: str | None = None) -> Any:
    """
    Load and verify a file written by safe_dump().

    Raises
    ------
    SecurityError  : HMAC verification failed (tampered file)
    SecurityError  : disallowed type found during unpickling
    FileNotFoundError : file does not exist
    ValueError     : file header is malformed or truncated
    """
    key = _get_or_create_key(cache_dir or os.path.dirname(path) or ".")

    with open(path, "rb") as f:
        raw = f.read()

    # ── Validate header ──────────────────────────────────────────
    magic_len   = len(_MAGIC)
    header_size = magic_len + 8   # MAGIC + uint64 length

    if len(raw) < header_size + _SIG_LENGTH:
        raise ValueError(
            f"Cache file '{path}' is too short to be a valid signed payload "
            f"({len(raw)} bytes). File may be corrupt or not produced by safe_dump()."
        )

    if raw[:magic_len] != _MAGIC:
        raise SecurityError(
            f"SECURITY: Cache file '{path}' has wrong magic header. "
            f"File was not produced by safe_dump() or has been replaced."
        )

    (payload_len,) = struct.unpack(">Q", raw[magic_len:header_size])
    expected_total = header_size + payload_len + _SIG_LENGTH

    if len(raw) != expected_total:
        raise ValueError(
            f"Cache file '{path}' size mismatch: expected {expected_total} bytes, "
            f"got {len(raw)}. File is corrupt."
        )

    payload = raw[header_size : header_size + payload_len]
    stored_sig = raw[header_size + payload_len :]

    # ── HMAC verification ─────────────────────────────────────────
    expected_sig = _compute_hmac(payload, key)
    if not hmac.compare_digest(stored_sig, expected_sig):
        raise SecurityError(
            f"SECURITY: HMAC verification FAILED for '{path}'. "
            f"The cache file has been tampered with or the key has changed. "
            f"Deleting corrupted cache and refusing to load."
        )

    # ── Restricted unpickling ─────────────────────────────────────
    return _RestrictedUnpickler(io.BytesIO(payload)).load()
