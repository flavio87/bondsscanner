import json
from typing import Any, Optional

import httpx

from .settings import get_env


class LlmClientError(RuntimeError):
    pass


def _get_provider() -> str:
    return (get_env("LLM_PROVIDER", "openrouter") or "openrouter").strip().lower()


def _get_api_key() -> Optional[str]:
    return get_env("OPENROUTER_API_KEY")


def _get_model() -> str:
    return get_env("OPENROUTER_MODEL", "openai/gpt-4o-mini") or "openai/gpt-4o-mini"


def _get_base_url() -> str:
    return get_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1") or "https://openrouter.ai/api/v1"


def _get_gemini_api_key() -> Optional[str]:
    return get_env("GEMINI_API_KEY")


def _get_gemini_model() -> str:
    return get_env("GEMINI_MODEL", "gemini-3-flash-preview") or "gemini-3-flash-preview"


def _get_gemini_base_url() -> str:
    return (
        get_env("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")
        or "https://generativelanguage.googleapis.com/v1beta"
    )


def _extract_openrouter_text(response: dict[str, Any]) -> str:
    return response["choices"][0]["message"]["content"]


def _extract_openrouter_sources(response: dict[str, Any]) -> list[str]:
    annotations = response.get("choices", [{}])[0].get("message", {}).get("annotations") or []
    sources = []
    for annotation in annotations:
        if annotation.get("type") == "url_citation":
            citation = annotation.get("url_citation") or {}
            url = citation.get("url")
            if url:
                sources.append(url)
    return list(dict.fromkeys(sources))


def _extract_gemini_text(response: dict[str, Any]) -> str:
    candidates = response.get("candidates") or []
    if not candidates:
        raise LlmClientError("Gemini response missing candidates")
    parts = candidates[0].get("content", {}).get("parts", []) or []
    text_parts = [part.get("text", "") for part in parts if part.get("text")]
    if not text_parts:
        raise LlmClientError("Gemini response missing text")
    return "".join(text_parts)


def _extract_gemini_sources(response: dict[str, Any]) -> list[str]:
    candidates = response.get("candidates") or []
    if not candidates:
        return []
    grounding = candidates[0].get("groundingMetadata") or {}
    chunks = grounding.get("groundingChunks") or []
    sources = []
    for chunk in chunks:
        web = chunk.get("web") or {}
        uri = web.get("uri")
        if uri:
            sources.append(uri)
    return list(dict.fromkeys(sources))


def call_openrouter(
    prompt: str,
    model: Optional[str] = None,
    plugins: Optional[list[dict[str, Any]]] = None,
    web_search_options: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    api_key = _get_api_key()
    if not api_key:
        raise LlmClientError("OPENROUTER_API_KEY is not set")

    payload: dict[str, Any] = {
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
    if plugins:
        payload["plugins"] = plugins
    if web_search_options:
        payload["web_search_options"] = web_search_options
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "Versified Bonds",
    }
    url = f"{_get_base_url().rstrip('/')}/chat/completions"
    try:
        with httpx.Client(timeout=60) as client:
            response = client.post(url, headers=headers, json=payload)
    except httpx.RequestError as exc:
        raise LlmClientError(f"OpenRouter request failed: {exc}") from exc
    if response.status_code >= 400:
        raise LlmClientError(f"OpenRouter error {response.status_code}: {response.text}")
    return response.json()


def call_gemini(
    prompt: str,
    model: Optional[str] = None,
    use_web: bool = False,
) -> dict[str, Any]:
    api_key = _get_gemini_api_key()
    if not api_key:
        raise LlmClientError("GEMINI_API_KEY is not set")

    prompt_text = "Return only valid JSON, no markdown or commentary.\n" + prompt
    payload: dict[str, Any] = {
        "contents": [{"parts": [{"text": prompt_text}]}],
        "generationConfig": {"temperature": 0.2},
    }
    if use_web:
        payload["tools"] = [{"google_search": {}}]

    model_name = model or _get_gemini_model()
    url = f"{_get_gemini_base_url().rstrip('/')}/models/{model_name}:generateContent"
    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=120) as client:
            response = client.post(url, headers=headers, json=payload)
    except httpx.RequestError as exc:
        raise LlmClientError(f"Gemini request failed: {exc}") from exc
    if response.status_code >= 400:
        raise LlmClientError(f"Gemini error {response.status_code}: {response.text}")
    return response.json()


def call_llm(
    prompt: str,
    model: Optional[str] = None,
    plugins: Optional[list[dict[str, Any]]] = None,
    web_search_options: Optional[dict[str, Any]] = None,
    use_web: bool = False,
) -> dict[str, Any]:
    provider = _get_provider()
    if provider == "gemini":
        response = call_gemini(prompt, model=model, use_web=use_web)
        text = _extract_gemini_text(response)
        sources = _extract_gemini_sources(response)
        model_name = model or _get_gemini_model()
    elif provider == "openrouter":
        response = call_openrouter(
            prompt,
            model=model,
            plugins=plugins,
            web_search_options=web_search_options,
        )
        text = _extract_openrouter_text(response)
        sources = _extract_openrouter_sources(response)
        model_name = response.get("model") or model or _get_model()
    else:
        raise LlmClientError(f"Unknown LLM provider: {provider}")
    return {
        "provider": provider,
        "model": model_name,
        "text": text,
        "sources": sources,
        "raw": response,
    }


def extract_json(text: str) -> dict[str, Any]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise
