"""Minimal UI state persistence.

Replaces ~880 lines of per-widget .change() handlers with batch save-on-action.
State saved when user clicks a button, not on every keystroke.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict


def _ui_state_store_path() -> str:
    return os.path.join("config", "ui_state.json")


def load_ui_state() -> Dict[str, Any]:
    path = _ui_state_store_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
        return {}
    except Exception:
        return {}


def save_ui_state(data: Dict[str, Any]) -> None:
    path = _ui_state_store_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def merge_ui_state(partial: Dict[str, Any]) -> None:
    state = load_ui_state()
    state.update(partial)
    save_ui_state(state)


def state_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def state_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def state_str(value: Any, default: str = "") -> str:
    return str(value).strip() if value else default
