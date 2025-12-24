import json
from typing import Any, Optional

import httpx

from .settings import get_env


class LlmClientError(RuntimeError):
    pass


def _get_api_key() -> Optional[str]:
    return get_env("OPENROUTER_API_KEY")


def _get_model() -> str:
    return get_env("OPENROUTER_MODEL", "openai/gpt-4o-mini") or "openai/gpt-4o-mini"


def _get_base_url() -> str:
    return get_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1") or "https://openrouter.ai/api/v1"


def call_openrouter(prompt: str, model: Optional[str] = None) -> dict[str, Any]:
    api_key = _get_api_key()
    if not api_key:
        raise LlmClientError("OPENROUTER_API_KEY is not set")

    payload = {
        "model": model or _get_model(),
        "messages": [
            {
                "role": "system",
                "content": "Return only valid JSON, no markdown or commentary.",
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "Versified Bonds",
    }
    url = f"{_get_base_url().rstrip('/')}/chat/completions"
    with httpx.Client(timeout=60) as client:
        response = client.post(url, headers=headers, json=payload)
    if response.status_code >= 400:
        raise LlmClientError(f"OpenRouter error {response.status_code}: {response.text}")
    return response.json()


def extract_json(text: str) -> dict[str, Any]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise
