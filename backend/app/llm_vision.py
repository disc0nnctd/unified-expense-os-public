from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Callable, Protocol

# Opt-in cloud LLM vision path, per the plan doc's Phase 7 policy: self-hosted
# small-model-first, any cloud model explicit opt-in. This module only turns
# a photo into a structured DRAFT (merchant/date/total/items); the caller
# still reviews/edits/confirms in the UI before anything reaches the ledger —
# same assist-only contract as the deterministic tesseract.js OCR path.

from .llm_provider import DEFAULT_BASE_URL, DEFAULT_MODEL

OPENROUTER_URL = f"{DEFAULT_BASE_URL}/chat/completions"

PROMPT = (
    "Extract structured data from this receipt image. Return ONLY minified JSON "
    "with keys: merchant (string), date (YYYY-MM-DD or null), total_paise "
    "(integer, total amount in smallest currency unit, or null), items (array of "
    "{label, amount_paise}). No markdown, no explanation, just the JSON object."
)


@dataclass(frozen=True)
class ParsedReceiptDraft:
    merchant: str | None
    date: str | None
    total_paise: int | None
    items: list[dict]


class HttpPoster(Protocol):
    def __call__(self, url: str, payload: dict, headers: dict) -> dict: ...


def _strip_markdown_fence(text: str) -> str:
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    return match.group(1) if match else text


def parse_llm_response_content(content: str) -> ParsedReceiptDraft:
    """Pure parsing of the model's text content into our draft shape —
    isolated from the HTTP call so it's testable against real model output
    without needing network access."""
    cleaned = _strip_markdown_fence(content).strip()
    data = json.loads(cleaned)
    items = data.get("items") or []
    if not isinstance(items, list):
        items = []
    return ParsedReceiptDraft(
        merchant=data.get("merchant"),
        date=data.get("date"),
        total_paise=data.get("total_paise"),
        items=[
            {"label": str(item.get("label", "")), "amount_paise": int(item.get("amount_paise", 0))}
            for item in items
            if isinstance(item, dict)
        ],
    )


class LlmVisionUnavailableError(Exception):
    pass


def http_poster(url: str, payload: dict, headers: dict) -> dict:
    """Real network implementation of HttpPoster, kept separate from
    extract_receipt_via_llm so tests can inject a fake and never touch the
    network."""
    import httpx

    response = httpx.post(url, json=payload, headers=headers, timeout=60.0)
    response.raise_for_status()
    return response.json()


def extract_receipt_via_llm(
    image_base64: str,
    api_key: str,
    poster: Callable[[str, dict, dict], dict],
    model: str = DEFAULT_MODEL,
    chat_url: str = OPENROUTER_URL,
    allow_empty_key: bool = False,
) -> ParsedReceiptDraft:
    if not api_key and not allow_empty_key:
        raise LlmVisionUnavailableError("no_api_key_configured")
    payload = {
        "model": model,
        "max_tokens": 800,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}},
                ],
            }
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = poster(chat_url, payload, headers)
    content = body["choices"][0]["message"]["content"]
    return parse_llm_response_content(content)
