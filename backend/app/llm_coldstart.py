from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Callable, Protocol

# Opt-in cloud LLM fallback for cold-start capture suggestions (Phase 7).
# New contexts have no ledger history, so the deterministic co-occurrence
# stats classify_capture() would normally lean on don't exist yet. This
# module borrows phrasing-level understanding instead — it only ever drafts
# a category/split SUGGESTION for the user to review, never writes to the
# ledger. Same DI + pure-parser shape as llm_vision.py / llm_capture.py.

from .llm_provider import DEFAULT_BASE_URL, DEFAULT_MODEL

OPENROUTER_URL = f"{DEFAULT_BASE_URL}/chat/completions"

PROMPT_TEMPLATE = (
    "A user in a brand-new expense-tracking context (no history yet) typed "
    "this capture text: {text!r}. Suggest a category and how it should "
    "likely be split. Return ONLY minified JSON with keys: category "
    "(string or null), split_hint (one of 'even', 'payer-only', or "
    "'unclear'), confidence (one of 'low', 'medium', 'high'). No markdown, "
    "no explanation, just the JSON object."
)


@dataclass(frozen=True)
class ColdStartSuggestion:
    category: str | None
    split_hint: str
    confidence: str


class HttpPoster(Protocol):
    def __call__(self, url: str, payload: dict, headers: dict) -> dict: ...


class LlmColdStartUnavailableError(Exception):
    pass


def _strip_markdown_fence(text: str) -> str:
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    return match.group(1) if match else text


_VALID_SPLIT_HINTS = {"even", "payer-only", "unclear"}
_VALID_CONFIDENCE = {"low", "medium", "high"}


def parse_llm_coldstart_response(content: str) -> ColdStartSuggestion:
    """Pure parsing of the model's text content into our suggestion shape —
    isolated from the HTTP call so it's testable against canned model
    output without needing network access."""
    cleaned = _strip_markdown_fence(content).strip()
    data = json.loads(cleaned)
    split_hint = data.get("split_hint")
    if split_hint not in _VALID_SPLIT_HINTS:
        split_hint = "unclear"
    confidence = data.get("confidence")
    if confidence not in _VALID_CONFIDENCE:
        confidence = "low"
    return ColdStartSuggestion(
        category=data.get("category"),
        split_hint=split_hint,
        confidence=confidence,
    )


def http_poster(url: str, payload: dict, headers: dict) -> dict:
    """Real network implementation of HttpPoster, kept separate from
    suggest_coldstart_via_llm so tests can inject a fake and never touch
    the network."""
    import httpx

    response = httpx.post(url, json=payload, headers=headers, timeout=60.0)
    response.raise_for_status()
    return response.json()


def suggest_coldstart_via_llm(
    text: str,
    api_key: str,
    poster: Callable[[str, dict, dict], dict],
    model: str = DEFAULT_MODEL,
    chat_url: str = OPENROUTER_URL,
    allow_empty_key: bool = False,
) -> ColdStartSuggestion:
    if not api_key and not allow_empty_key:
        raise LlmColdStartUnavailableError("no_api_key_configured")
    payload = {
        "model": model,
        "max_tokens": 200,
        "messages": [
            {"role": "user", "content": PROMPT_TEMPLATE.format(text=text)}
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = poster(chat_url, payload, headers)
    content = body["choices"][0]["message"]["content"]
    return parse_llm_coldstart_response(content)
