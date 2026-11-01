from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Callable, Protocol

from .llm_provider import DEFAULT_BASE_URL, DEFAULT_MODEL

# Opt-in cloud LLM fallback for natural-language capture (Phase 7), per the
# plan doc's self-hosted-first / cloud-explicit-opt-in policy. This only ever
# fires when the deterministic classify_capture() confidence is "low" — it
# drafts a structured SUGGESTION (description/amount/category/participants/
# payer/split) that the user must still review/edit/confirm before anything
# reaches the ledger. Same DI + pure-parser shape as llm_vision.py: keep HTTP
# separate from parsing so tests never touch the network.
#
# Voice capture (unified-expense-os-mi5) reuses this exact endpoint: a spoken
# transcript is just capture text, so the draft carries optional payer/split
# fields. Names stay plain strings — the server never resolves them to
# participant ids; only the client, against its local membership list, may.

OPENROUTER_URL = f"{DEFAULT_BASE_URL}/chat/completions"

PROMPT_TEMPLATE = (
    "A user typed or spoke this expense capture text: {text!r}. Draft a "
    "structured suggestion. Return ONLY minified JSON with keys: description "
    "(string), amount_paise (integer, total amount in smallest currency "
    "unit, or null if not mentioned), category (string or null), "
    "participants (array of strings — names mentioned as involved, empty "
    "array if none mentioned), payer (string name of who paid, or null), "
    "split_mode (one of 'equal', 'shares', 'custom', or null if not "
    "mentioned), shares (object mapping name to relative share weight, or "
    "null — e.g. {{\"Asha\": 2, \"Ravi\": 1}} for a 2:1 split), amounts_paise "
    "(object mapping name to exact integer amount in smallest currency unit, "
    "or null), context_hint (string name of the group/context mentioned, or "
    "null), date (YYYY-MM-DD or null), currency (ISO 4217 code like 'INR', "
    "'USD', 'EUR', 'GBP' when a currency is stated or clearly implied by a "
    "symbol, else null — do not guess). Never invent names not present in "
    "the text. No markdown, no explanation, just the JSON object."
)

_VALID_SPLIT_MODES = {"equal", "shares", "custom"}


@dataclass(frozen=True)
class CaptureDraft:
    description: str | None
    amount_paise: int | None
    category: str | None
    participants: list[str]
    payer: str | None = None
    split_mode: str | None = None
    shares: dict[str, float] | None = None
    amounts_paise: dict[str, int] | None = None
    context_hint: str | None = None
    date: str | None = None
    currency: str | None = None


class HttpPoster(Protocol):
    def __call__(self, url: str, payload: dict, headers: dict) -> dict: ...


class LlmCaptureUnavailableError(Exception):
    pass


def _strip_markdown_fence(text: str) -> str:
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    return match.group(1) if match else text


def _clean_name_number_map(value: object, cast: Callable[[object], float | int]) -> dict | None:
    """Model output is untrusted: keep only string→number pairs, drop the
    rest, and collapse empty/invalid maps to None so old-shape responses
    (fields absent entirely) and garbage responses degrade identically."""
    if not isinstance(value, dict):
        return None
    cleaned = {}
    for key, raw in value.items():
        try:
            cleaned[str(key)] = cast(raw)
        except (TypeError, ValueError):
            continue
    return cleaned or None


def parse_llm_capture_response(content: str) -> CaptureDraft:
    """Pure parsing of the model's text content into our draft shape —
    isolated from the HTTP call so it's testable against canned model
    output without needing network access. Every extended field is optional
    so pre-extension model responses still parse."""
    cleaned = _strip_markdown_fence(content).strip()
    data = json.loads(cleaned)
    participants = data.get("participants") or []
    if not isinstance(participants, list):
        participants = []
    split_mode = data.get("split_mode")
    if split_mode not in _VALID_SPLIT_MODES:
        split_mode = None
    payer = data.get("payer")
    context_hint = data.get("context_hint")
    date = data.get("date")
    # Currency is untrusted model output: accept only a plausible ISO 4217
    # alpha code; anything else collapses to None (client then asks/defaults).
    currency = data.get("currency")
    if not (isinstance(currency, str) and re.fullmatch(r"[A-Za-z]{3}", currency.strip())):
        currency = None
    return CaptureDraft(
        description=data.get("description"),
        amount_paise=data.get("amount_paise"),
        category=data.get("category"),
        participants=[str(p) for p in participants],
        payer=str(payer) if payer is not None else None,
        split_mode=split_mode,
        shares=_clean_name_number_map(data.get("shares"), float),
        amounts_paise=_clean_name_number_map(data.get("amounts_paise"), int),
        context_hint=str(context_hint) if context_hint is not None else None,
        date=str(date) if date is not None else None,
        currency=currency.strip().upper() if currency is not None else None,
    )


def http_poster(url: str, payload: dict, headers: dict) -> dict:
    """Real network implementation of HttpPoster, kept separate from
    draft_capture_via_llm so tests can inject a fake and never touch the
    network."""
    import httpx

    response = httpx.post(url, json=payload, headers=headers, timeout=60.0)
    response.raise_for_status()
    return response.json()


def build_llm_headers(api_key: str) -> dict:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def draft_capture_via_llm(
    text: str,
    api_key: str,
    poster: Callable[[str, dict, dict], dict],
    model: str = DEFAULT_MODEL,
    chat_url: str = OPENROUTER_URL,
    allow_empty_key: bool = False,
) -> CaptureDraft:
    if not api_key and not allow_empty_key:
        raise LlmCaptureUnavailableError("no_api_key_configured")
    payload = {
        "model": model,
        "max_tokens": 500,
        "messages": [
            {"role": "user", "content": PROMPT_TEMPLATE.format(text=text)}
        ],
    }
    body = poster(chat_url, payload, build_llm_headers(api_key))
    content = body["choices"][0]["message"]["content"]
    return parse_llm_capture_response(content)
