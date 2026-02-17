"""Unified LLM provider client.

Deduplicates the ~150 lines of near-identical HTTP/provider routing
that existed in both generate_ccv3.py and fidelity_lab.py.
"""

from __future__ import annotations

import json
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import requests


PROVIDER_CHOICES = ["ollama", "openai", "openrouter", "anthropic"]


@dataclass
class LLMConfig:
    provider: str = "ollama"
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    site_url: str = "http://localhost"
    app_name: str = "companion-preserver"
    temperature: float = 0.2
    timeout: int = 180
    max_tokens: int = 4000


def default_base_url(provider: str, override: str = "") -> str:
    if override.strip():
        return override.strip().rstrip("/")
    defaults = {
        "ollama": "http://127.0.0.1:11434",
        "openai": "https://api.openai.com",
        "openrouter": "https://openrouter.ai/api/v1",
        "anthropic": "https://api.anthropic.com",
    }
    return defaults.get((provider or "").strip(), "")


def _post_json(
    url: str,
    payload: Dict[str, Any],
    headers: Dict[str, str],
    timeout: int,
) -> Dict[str, Any]:
    response = requests.post(url, json=payload, headers=headers, timeout=timeout)
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        body = response.text.strip()
        if len(body) > 500:
            body = body[:500] + "..."
        raise RuntimeError(f"{exc} | response={body}") from exc
    try:
        return response.json()
    except ValueError as exc:
        body = response.text.strip()
        if len(body) > 500:
            body = body[:500] + "..."
        raise RuntimeError(f"Invalid JSON response from {url} | response={body}") from exc


def _is_retryable_error(error_text: str) -> bool:
    text = (error_text or "").lower()
    retry_markers = [
        "429", "503", "504", "502",
        "too many requests", "rate limit", "overloaded",
        "engine is currently overloaded", "temporarily unavailable",
        "service unavailable", "timeout", "timed out",
        "connection reset", "try again later",
    ]
    return any(marker in text for marker in retry_markers)


def _post_json_with_retry(
    url: str,
    payload: Dict[str, Any],
    headers: Dict[str, str],
    timeout: int,
    max_attempts: int = 6,
) -> Dict[str, Any]:
    attempt = 1
    while True:
        try:
            return _post_json(url=url, payload=payload, headers=headers, timeout=timeout)
        except Exception as exc:
            if attempt >= max_attempts or not _is_retryable_error(str(exc)):
                raise
            sleep_seconds = min(45.0, (2 ** (attempt - 1)) + random.uniform(0.0, 1.0))
            time.sleep(sleep_seconds)
            attempt += 1


def _build_headers(config: LLMConfig, base: str) -> Dict[str, str]:
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    if config.provider in {"openai", "openrouter"} and config.api_key:
        headers["Authorization"] = f"Bearer {config.api_key}"
    if config.provider == "openrouter":
        if config.site_url:
            headers["HTTP-Referer"] = config.site_url
        if config.app_name:
            headers["X-Title"] = config.app_name
    if config.provider == "anthropic":
        headers["x-api-key"] = config.api_key
        headers["anthropic-version"] = "2023-06-01"
    return headers


def _openai_endpoint(base: str) -> str:
    return "/chat/completions" if base.endswith("/v1") else "/v1/chat/completions"


def _convert_to_anthropic_messages(
    messages: List[Dict[str, str]],
) -> Tuple[str, List[Dict[str, Any]]]:
    system_chunks = [m["content"] for m in messages if m.get("role") == "system"]
    system_text = "\n\n".join(system_chunks).strip()
    anthropic_messages: List[Dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role")
        if role == "system":
            continue
        mapped = "assistant" if role == "assistant" else "user"
        anthropic_messages.append(
            {"role": mapped, "content": [{"type": "text", "text": msg.get("content", "")}]}
        )
    return system_text, anthropic_messages


def chat_complete(
    config: LLMConfig,
    messages: List[Dict[str, str]],
) -> str:
    """Send a chat completion request and return the text response."""
    base = default_base_url(config.provider, config.base_url)
    headers = _build_headers(config, base)

    if config.provider == "ollama":
        payload = {
            "model": config.model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": config.temperature},
        }
        data = _post_json_with_retry(
            f"{base}/api/chat", payload, headers=headers, timeout=config.timeout,
        )
        return (((data.get("message") or {}).get("content")) or "").strip()

    if config.provider in {"openai", "openrouter"}:
        payload = {
            "model": config.model,
            "temperature": config.temperature,
            "messages": messages,
        }
        endpoint = _openai_endpoint(base)
        data = _post_json_with_retry(
            f"{base}{endpoint}", payload, headers=headers, timeout=config.timeout,
        )
        choices = data.get("choices") or []
        if not choices:
            return ""
        return (((choices[0] or {}).get("message") or {}).get("content") or "").strip()

    if config.provider == "anthropic":
        system_text, anthropic_messages = _convert_to_anthropic_messages(messages)
        payload = {
            "model": config.model,
            "max_tokens": config.max_tokens,
            "temperature": config.temperature,
            "system": system_text,
            "messages": anthropic_messages,
        }
        data = _post_json_with_retry(
            f"{base}/v1/messages", payload, headers=headers, timeout=config.timeout,
        )
        content_blocks = data.get("content") or []
        texts: List[str] = []
        for block in content_blocks:
            if isinstance(block, dict) and block.get("type") == "text":
                texts.append(block.get("text", ""))
        return "\n".join(texts).strip()

    raise RuntimeError(f"Unsupported provider: {config.provider}")


def extract_json_object(raw: str) -> Dict[str, Any]:
    """Parse a JSON object from LLM output, handling markdown fences and noise."""
    text = raw.strip()
    if not text:
        return {}

    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        block = fenced.group(1)
        try:
            obj = json.loads(block)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass

    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        candidate = text[start : end + 1]
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            return {}

    return {}


def chat_complete_json(
    config: LLMConfig,
    messages: List[Dict[str, str]],
) -> Tuple[Dict[str, Any], str]:
    """Send a chat completion and parse the response as JSON.

    Returns (parsed_dict, raw_text).
    For openai/openrouter, tries response_format=json_object first.
    """
    base = default_base_url(config.provider, config.base_url)
    headers = _build_headers(config, base)

    if config.provider == "ollama":
        payload = {
            "model": config.model,
            "messages": messages,
            "stream": False,
            "format": "json",
            "options": {"temperature": config.temperature},
        }
        data = _post_json_with_retry(
            f"{base}/api/chat", payload, headers=headers, timeout=config.timeout,
        )
        content = ((data.get("message") or {}).get("content")) or ""
        return extract_json_object(content), content

    if config.provider in {"openai", "openrouter"}:
        payload = {
            "model": config.model,
            "temperature": config.temperature,
            "response_format": {"type": "json_object"},
            "messages": messages,
        }
        endpoint = _openai_endpoint(base)
        url = f"{base}{endpoint}"
        try:
            data = _post_json_with_retry(url, payload, headers=headers, timeout=config.timeout)
        except Exception:
            payload_fallback = {
                "model": config.model,
                "temperature": config.temperature,
                "messages": messages,
            }
            data = _post_json_with_retry(url, payload_fallback, headers=headers, timeout=config.timeout)
        choices = data.get("choices") or []
        if not choices:
            return {}, ""
        content = (((choices[0] or {}).get("message") or {}).get("content")) or ""
        return extract_json_object(content), content

    if config.provider == "anthropic":
        system_text, anthropic_messages = _convert_to_anthropic_messages(messages)
        payload = {
            "model": config.model,
            "max_tokens": config.max_tokens,
            "temperature": config.temperature,
            "system": system_text,
            "messages": anthropic_messages,
        }
        data = _post_json_with_retry(
            f"{base}/v1/messages", payload, headers=headers, timeout=config.timeout,
        )
        content_blocks = data.get("content") or []
        text_parts: List[str] = []
        for block in content_blocks:
            if isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", ""))
        content = "\n".join(text_parts).strip()
        return extract_json_object(content), content

    return {}, ""


def fetch_models_with_metadata(
    config: LLMConfig,
    timeout: int = 30,
) -> Tuple[List[str], Dict[str, int]]:
    """Fetch available models and their context window metadata from a provider."""
    provider = (config.provider or "").strip()
    base = default_base_url(provider, config.base_url)
    models: List[str] = []
    model_windows: Dict[str, int] = {}

    if provider == "ollama":
        r = requests.get(f"{base}/api/tags", timeout=timeout)
        r.raise_for_status()
        data = r.json()
        for item in data.get("models") or []:
            if isinstance(item, dict):
                name = str(item.get("name", "")).strip()
                if name:
                    models.append(name)
                    context_hint = (
                        item.get("context_length")
                        or item.get("num_ctx")
                        or item.get("context_window")
                    )
                    try:
                        window = int(context_hint)
                    except (TypeError, ValueError):
                        window = 0
                    if window > 0:
                        model_windows[name] = window

    elif provider in {"openai", "openrouter"}:
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if config.api_key:
            headers["Authorization"] = f"Bearer {config.api_key}"
        if provider == "openrouter":
            if config.site_url:
                headers["HTTP-Referer"] = config.site_url
            if config.app_name:
                headers["X-Title"] = config.app_name
        endpoint = "/models" if (base.endswith("/v1") or base.endswith("/api/v1")) else "/v1/models"
        r = requests.get(f"{base}{endpoint}", headers=headers, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        for item in data.get("data") or []:
            if isinstance(item, dict):
                name = str(item.get("id", "")).strip()
                if name:
                    models.append(name)
                    context_hint = (
                        item.get("context_length")
                        or item.get("max_context_length")
                        or item.get("input_token_limit")
                        or item.get("context_window")
                    )
                    try:
                        window = int(context_hint)
                    except (TypeError, ValueError):
                        window = 0
                    if window > 0:
                        model_windows[name] = window

    elif provider == "anthropic":
        headers = {
            "x-api-key": config.api_key,
            "anthropic-version": "2023-06-01",
        }
        r = requests.get(f"{base}/v1/models", headers=headers, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        for item in data.get("data") or []:
            if isinstance(item, dict):
                name = str(item.get("id", "")).strip()
                if name:
                    models.append(name)
                    context_hint = item.get("context_window") or item.get("input_token_limit")
                    try:
                        window = int(context_hint)
                    except (TypeError, ValueError):
                        window = 0
                    if window > 0:
                        model_windows[name] = window

    return sorted(set(models)), model_windows
