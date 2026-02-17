"""Scan manifest for tracking processed conversations across runs.

Stores per-conversation extraction results so generation can resume
without re-scanning already-processed files. Synthesis always re-runs
over ALL accumulated results (cheap: 1-2 LLM calls).
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def _now_utc() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def load_manifest(path: str) -> Dict[str, Any]:
    """Load an existing manifest or return an empty one."""
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def save_manifest(path: str, data: Dict[str, Any]) -> None:
    """Atomic write of manifest to disk."""
    data["updated_at_utc"] = _now_utc()
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def new_manifest(input_dir: str) -> Dict[str, Any]:
    """Create a fresh empty manifest."""
    return {
        "input_dir": input_dir,
        "created_at_utc": _now_utc(),
        "updated_at_utc": _now_utc(),
        "scanned_files": {},
    }


def file_is_scanned(manifest: Dict[str, Any], filename: str, size: int, mtime: float) -> bool:
    """Check if a file has already been scanned (matching size + mtime)."""
    scanned = manifest.get("scanned_files", {})
    entry = scanned.get(filename)
    if not isinstance(entry, dict):
        return False
    return entry.get("file_size") == size and entry.get("file_mtime") == mtime


def record_scan(
    manifest: Dict[str, Any],
    filename: str,
    size: int,
    mtime: float,
    persona_observation: Optional[Dict[str, Any]],
    memory_candidates: List[Dict[str, Any]],
) -> None:
    """Record results for a single conversation file."""
    if "scanned_files" not in manifest:
        manifest["scanned_files"] = {}
    manifest["scanned_files"][filename] = {
        "file_size": size,
        "file_mtime": mtime,
        "persona_observation": persona_observation,
        "memory_candidates": memory_candidates,
        "scanned_at_utc": _now_utc(),
    }


def get_accumulated_observations(manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Collect all persona observations across scanned files."""
    results: List[Dict[str, Any]] = []
    for entry in (manifest.get("scanned_files") or {}).values():
        if not isinstance(entry, dict):
            continue
        obs = entry.get("persona_observation")
        if isinstance(obs, dict) and obs:
            results.append(obs)
    return results


def get_accumulated_candidates(manifest: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Collect all memory candidates across scanned files."""
    results: List[Dict[str, Any]] = []
    for entry in (manifest.get("scanned_files") or {}).values():
        if not isinstance(entry, dict):
            continue
        candidates = entry.get("memory_candidates")
        if isinstance(candidates, list):
            results.extend(c for c in candidates if isinstance(c, dict))
    return results


def get_file_info(path: str) -> tuple[int, float]:
    """Return (size, mtime) for a file."""
    stat = os.stat(path)
    return stat.st_size, stat.st_mtime
