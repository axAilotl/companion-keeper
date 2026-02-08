"""Preset, model cache, budget management, and .env loading."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

from .llm_client import LLMConfig, PROVIDER_CHOICES, default_base_url, fetch_models_with_metadata


OPENROUTER_SITE_DEFAULT = os.environ.get("OPENROUTER_SITE_URL", "http://localhost")
OPENROUTER_APP_DEFAULT = os.environ.get("OPENROUTER_APP_NAME", "companion-preserver")

CONTEXT_PROFILE_CHOICES: List[Tuple[str, str]] = [
    ("Auto (from model metadata)", "auto"),
    ("64k Balanced", "64k"),
    ("128k Balanced", "128k"),
    ("200k Deep", "200k"),
    ("1M Extended", "1m"),
]

CONTEXT_PROFILE_WINDOWS = {
    "64k": 64_000,
    "128k": 128_000,
    "200k": 200_000,
    "1m": 1_000_000,
}

CONTEXT_BUDGET_PRESETS = {
    "64k": {
        "max_messages_per_conversation": 50,
        "max_chars_per_conversation": 9_000,
        "max_total_chars": 90_000,
        "request_timeout": 180,
    },
    "128k": {
        "max_messages_per_conversation": 70,
        "max_chars_per_conversation": 14_000,
        "max_total_chars": 160_000,
        "request_timeout": 240,
    },
    "200k": {
        "max_messages_per_conversation": 90,
        "max_chars_per_conversation": 18_000,
        "max_total_chars": 240_000,
        "request_timeout": 300,
    },
    "1m": {
        "max_messages_per_conversation": 120,
        "max_chars_per_conversation": 26_000,
        "max_total_chars": 420_000,
        "request_timeout": 480,
    },
}

DEFAULT_CONVERSATION_SAMPLING = "weighted-random"
DEFAULT_SAMPLING_SEED = -1


def load_dotenv_file(path: str = ".env") -> None:
    if not os.path.isfile(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("\"'").strip()
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception:
        pass


def _provider_env_key(provider: str) -> str:
    mapping = {
        "openrouter": "OPENROUTER_API_KEY",
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
    }
    return mapping.get((provider or "").strip(), "")


def resolve_api_key(provider: str, provided_value: str) -> str:
    value = (provided_value or "").strip()
    if value:
        return value
    env_key = _provider_env_key(provider)
    return os.environ.get(env_key, "")


# --- Preset store ---

def _preset_store_path() -> str:
    return os.path.join("config", "llm_presets.json")


def load_presets() -> Dict[str, Dict[str, str]]:
    path = _preset_store_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {}
        out: Dict[str, Dict[str, str]] = {}
        for k, v in data.items():
            if isinstance(k, str) and isinstance(v, dict):
                out[k] = {
                    "provider": str(v.get("provider", "")).strip(),
                    "base_url": str(v.get("base_url", "")).strip(),
                    "api_key": str(v.get("api_key", "")).strip(),
                }
        return out
    except Exception:
        return {}


def save_presets(presets: Dict[str, Dict[str, str]]) -> None:
    path = _preset_store_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(presets, f, ensure_ascii=False, indent=2)


def bootstrap_presets_from_env() -> None:
    presets = load_presets()
    changed = False
    if "openrouter-env" not in presets and os.environ.get("OPENROUTER_API_KEY", "").strip():
        presets["openrouter-env"] = {
            "provider": "openrouter",
            "base_url": default_base_url("openrouter"),
            "api_key": os.environ.get("OPENROUTER_API_KEY", "").strip(),
        }
        changed = True
    if "ollama-local" not in presets:
        presets["ollama-local"] = {
            "provider": "ollama",
            "base_url": default_base_url("ollama"),
            "api_key": "",
        }
        changed = True
    if changed:
        save_presets(presets)


def preset_names() -> List[str]:
    return sorted(load_presets().keys())


def preferred_default_preset() -> Optional[str]:
    names = preset_names()
    if not names:
        return None
    for preferred in ["openrouter-env", "ollama-local"]:
        if preferred in names:
            return preferred
    return names[0]


def resolve_preset_config(preset_name: str) -> Tuple[Optional[Dict[str, str]], str]:
    name = (preset_name or "").strip()
    if not name:
        return None, "No preset selected."
    presets = load_presets()
    preset = presets.get(name)
    if not preset:
        return None, f"Preset not found: {name}"
    provider = (preset.get("provider") or "").strip()
    if provider not in PROVIDER_CHOICES:
        return None, f"Preset provider is invalid for {name}"
    api_key = resolve_api_key(provider, preset.get("api_key", ""))
    return {
        "provider": provider,
        "base_url": (preset.get("base_url") or "").strip() or default_base_url(provider),
        "api_key": api_key,
        "site_url": OPENROUTER_SITE_DEFAULT,
        "app_name": OPENROUTER_APP_DEFAULT,
    }, ""


def preset_to_llm_config(preset_name: str, model: str = "", **overrides: Any) -> Tuple[Optional[LLMConfig], str]:
    """Resolve a preset name into a ready-to-use LLMConfig."""
    resolved, err = resolve_preset_config(preset_name)
    if err or not resolved:
        return None, err or "Failed to resolve preset."
    cfg = LLMConfig(
        provider=resolved["provider"],
        base_url=resolved["base_url"],
        model=(model or "").strip(),
        api_key=resolved["api_key"],
        site_url=resolved.get("site_url", OPENROUTER_SITE_DEFAULT),
        app_name=resolved.get("app_name", OPENROUTER_APP_DEFAULT),
        **overrides,
    )
    return cfg, ""


# --- Model cache ---

def _model_cache_store_path() -> str:
    return os.path.join("config", "llm_model_cache.json")


def _model_meta_cache_store_path() -> str:
    return os.path.join("config", "llm_model_meta_cache.json")


def load_model_cache() -> Dict[str, List[str]]:
    path = _model_cache_store_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        out: Dict[str, List[str]] = {}
        if isinstance(data, dict):
            for key, value in data.items():
                if isinstance(key, str) and isinstance(value, list):
                    out[key] = [str(v).strip() for v in value if str(v).strip()]
        return out
    except Exception:
        return {}


def save_model_cache(cache: Dict[str, List[str]]) -> None:
    path = _model_cache_store_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def load_model_meta_cache() -> Dict[str, Dict[str, int]]:
    path = _model_meta_cache_store_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        out: Dict[str, Dict[str, int]] = {}
        if isinstance(data, dict):
            for preset_name, meta in data.items():
                if not isinstance(preset_name, str) or not isinstance(meta, dict):
                    continue
                clean: Dict[str, int] = {}
                for model_name, raw_window in meta.items():
                    if not isinstance(model_name, str):
                        continue
                    try:
                        window = int(raw_window)
                    except (TypeError, ValueError):
                        continue
                    if window > 0:
                        clean[model_name] = window
                out[preset_name] = clean
        return out
    except Exception:
        return {}


def save_model_meta_cache(cache: Dict[str, Dict[str, int]]) -> None:
    path = _model_meta_cache_store_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def cache_models_for_preset(preset_name: str, models: List[str]) -> None:
    key = (preset_name or "").strip()
    if not key:
        return
    cache = load_model_cache()
    cache[key] = sorted(set(m for m in models if m.strip()))
    save_model_cache(cache)


def cache_model_meta_for_preset(preset_name: str, model_meta: Dict[str, int]) -> None:
    key = (preset_name or "").strip()
    if not key:
        return
    cache = load_model_meta_cache()
    clean: Dict[str, int] = {}
    for model_name, raw_window in (model_meta or {}).items():
        name = str(model_name).strip()
        if not name:
            continue
        try:
            window = int(raw_window)
        except (TypeError, ValueError):
            continue
        if window > 0:
            clean[name] = window
    cache[key] = clean
    save_model_meta_cache(cache)


def get_cached_models(preset_name: str) -> List[str]:
    key = (preset_name or "").strip()
    if not key:
        return []
    return load_model_cache().get(key, [])


def get_cached_context_window(preset_name: str, model_name: str) -> int:
    key = (preset_name or "").strip()
    name = (model_name or "").strip()
    if not key or not name:
        return 0
    return int(load_model_meta_cache().get(key, {}).get(name, 0) or 0)


# --- Context budget helpers ---

def bucket_for_window(window_tokens: int) -> str:
    if window_tokens >= 500_000:
        return "1m"
    if window_tokens >= 180_000:
        return "200k"
    if window_tokens >= 100_000:
        return "128k"
    return "64k"


def derive_context_and_budget(
    preset_name: str,
    model_name: str,
    context_profile: str,
) -> Tuple[str, int, Dict[str, int]]:
    from .generate import infer_context_window  # avoid circular at module level

    profile = (context_profile or "auto").strip().lower()
    model = (model_name or "").strip()
    source = "manual profile"

    if profile == "auto":
        cached_window = get_cached_context_window(preset_name, model)
        inferred_window = 0
        if model:
            try:
                inferred_window = int(infer_context_window(model))
            except Exception:
                inferred_window = 0
        context_window = cached_window or inferred_window or CONTEXT_PROFILE_WINDOWS["128k"]
        bucket = bucket_for_window(context_window)
        source = "model metadata" if cached_window else ("model-name heuristic" if inferred_window else "default")
    else:
        bucket = profile if profile in CONTEXT_BUDGET_PRESETS else "128k"
        context_window = CONTEXT_PROFILE_WINDOWS.get(bucket, CONTEXT_PROFILE_WINDOWS["128k"])

    budget = dict(CONTEXT_BUDGET_PRESETS[bucket])
    return source, int(context_window), budget
