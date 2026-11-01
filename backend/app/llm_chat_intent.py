from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Callable, Protocol

from .llm_capture import CaptureDraft, _clean_name_number_map, _VALID_SPLIT_MODES
from .llm_provider import DEFAULT_BASE_URL, DEFAULT_MODEL

# Opt-in LLM intent mapper for the chat assistant (unified-expense-os-kct).
# Stateless by design: for THIS endpoint (/capture/chat-intent) the client
# sends recent turns + compact schema context (names only — never the raw
# ledger) and gets back ONE structured intent. The model's only job is
# translating fuzzy phrasing into the closed intent vocabulary below; it must
# NEVER compute ledger numbers — query_ledger returns a structured query the
# client's deterministic compiler executes (lib/qa.ts → finance.ts), and
# drafts are suggestions the user still reviews and explicitly saves.
#
# NOTE (unified-expense-os-84x): raw_completion() below is also the transport
# for /capture/agent, where the client-built prompt DOES contain a compact
# ledger digest (descriptions, amounts, payers, splits, balances) plus any
# mid-turn tool results. That traffic is opt-in, disclosed in the chat consent
# copy, and goes to whichever provider the deployment/participant configured.
# "Names only" describes chat-intent, not the agent relay — do not generalize
# it. Nothing here imports or touches the ledger.
# Same DI + pure-parser shape as llm_capture.py.

OPENROUTER_URL = f"{DEFAULT_BASE_URL}/chat/completions"

VALID_INTENTS = {
    "query_ledger",
    "draft_expense",
    "draft_settlement",
    "draft_recurring",
    "void_expense",
    "clarify",
    "none",
}

GENERIC_CLARIFY_QUESTION = (
    "Sorry, I didn't quite get that. Could you rephrase — for example "
    "'add 450 dinner split equally' or 'what did we spend on groceries "
    "this month'?"
)

SYSTEM_PROMPT_TEMPLATE = (
    "You map a user's message in an expense-tracking chat to ONE structured "
    "intent. Return ONLY minified JSON, no markdown, with keys: intent, "
    "draft, query, clarify_question, reply.\n"
    "intent MUST be exactly one of: query_ledger, draft_expense, "
    "draft_settlement, draft_recurring, clarify, none.\n"
    "- query_ledger: the user asks about their spending/balances/history. "
    "Set query to {{\"metric\": string or null, \"timeframe\": string or "
    "null, \"category\": string or null, \"person\": string or null}}. "
    "Prefer metric values: total_spend, category_spend, member_spend, "
    "owed_to_me, i_owe, balances_breakdown (who owes how much / everyone's "
    "balances); otherwise copy the user's own words. NEVER compute, "
    "estimate, or state any amount, total, or balance yourself — the app "
    "computes numbers from its ledger. Set draft to null.\n"
    "- draft_expense / draft_settlement / draft_recurring: the user wants to "
    "record something. Set draft to {{\"description\": string, "
    "\"amount_paise\": integer or null (smallest currency unit), "
    "\"category\": string or null, \"participants\": array of name strings, "
    "\"payer\": string or null, \"split_mode\": 'equal'|'shares'|'custom' or "
    "null, \"shares\": object name->weight or null, \"amounts_paise\": "
    "object name->integer or null, \"context_hint\": string or null, "
    "\"date\": YYYY-MM-DD or null}}. Set query to null.\n"
    "- void_expense: the user wants to delete/remove/undo an already-saved "
    "expense. Set void_target to their own words for which one (e.g. 'last "
    "pizza'). The app finds the entry and asks the user to confirm — never "
    "pick ids or amounts yourself. Set draft and query to null.\n"
    "- clarify: the request is ambiguous; set clarify_question to ONE short "
    "question.\n"
    "- none: small talk or out of scope; set a brief friendly reply.\n"
    "reply: optional one-sentence acknowledgement (never a number from the "
    "ledger).\n"
    "Use names only from these lists, as plain strings (never ids, never "
    "invented names). Contexts: {context_names}. People: "
    "{participant_names}. Categories: {category_names}.\n"
    "Unknown or unmatchable name → clarify. All unused keys must be null."
)


@dataclass(frozen=True)
class ChatQuery:
    metric: str | None
    timeframe: str | None
    category: str | None
    person: str | None


@dataclass(frozen=True)
class ChatIntentResult:
    intent: str
    draft: CaptureDraft | None
    query: ChatQuery | None
    clarify_question: str | None
    reply: str | None
    # For void_expense: the user's words describing which entry ("last
    # pizza", "yesterday's cab"). The client resolves it against the local
    # ledger and asks for confirmation — the model never picks an entry id.
    void_target: str | None = None


class HttpPoster(Protocol):
    def __call__(self, url: str, payload: dict, headers: dict) -> dict: ...


class LlmChatIntentUnavailableError(Exception):
    pass


def _strip_markdown_fence(text: str) -> str:
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    return match.group(1) if match else text


def _clarify_fallback() -> ChatIntentResult:
    return ChatIntentResult(
        intent="clarify",
        draft=None,
        query=None,
        clarify_question=GENERIC_CLARIFY_QUESTION,
        reply=None,
    )


def _parse_draft(data: object) -> CaptureDraft | None:
    if not isinstance(data, dict):
        return None
    participants = data.get("participants") or []
    if not isinstance(participants, list):
        participants = []
    split_mode = data.get("split_mode")
    if split_mode not in _VALID_SPLIT_MODES:
        split_mode = None
    amount = data.get("amount_paise")
    if not isinstance(amount, int) or isinstance(amount, bool):
        amount = None
    payer = data.get("payer")
    context_hint = data.get("context_hint")
    date = data.get("date")
    description = data.get("description")
    category = data.get("category")
    return CaptureDraft(
        description=str(description) if description is not None else None,
        amount_paise=amount,
        category=str(category) if category is not None else None,
        participants=[str(p) for p in participants],
        payer=str(payer) if payer is not None else None,
        split_mode=split_mode,
        shares=_clean_name_number_map(data.get("shares"), float),
        amounts_paise=_clean_name_number_map(data.get("amounts_paise"), int),
        context_hint=str(context_hint) if context_hint is not None else None,
        date=str(date) if date is not None else None,
    )


def _parse_query(data: object) -> ChatQuery | None:
    if not isinstance(data, dict):
        return None

    def _opt(key: str) -> str | None:
        value = data.get(key)
        return str(value) if value is not None else None

    return ChatQuery(
        metric=_opt("metric"),
        timeframe=_opt("timeframe"),
        category=_opt("category"),
        person=_opt("person"),
    )


def parse_chat_intent_response(content: str) -> ChatIntentResult:
    """Pure, total parsing of the model's text content: any unparseable or
    out-of-vocabulary response coerces to a generic clarify — the assistant
    asks again rather than the endpoint ever 500ing on model misbehavior."""
    cleaned = _strip_markdown_fence(content).strip()
    try:
        data = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        return _clarify_fallback()
    if not isinstance(data, dict):
        return _clarify_fallback()
    intent = data.get("intent")
    if intent not in VALID_INTENTS:
        return _clarify_fallback()
    clarify_question = data.get("clarify_question")
    if intent == "clarify" and not clarify_question:
        clarify_question = GENERIC_CLARIFY_QUESTION
    reply = data.get("reply")
    void_target = data.get("void_target")
    return ChatIntentResult(
        intent=intent,
        draft=_parse_draft(data.get("draft")) if intent.startswith("draft_") else None,
        query=_parse_query(data.get("query")) if intent == "query_ledger" else None,
        clarify_question=str(clarify_question) if clarify_question is not None else None,
        reply=str(reply) if reply is not None else None,
        void_target=str(void_target) if intent == "void_expense" and void_target is not None else None,
    )


def raw_completion(
    prompt: str,
    api_key: str,
    poster: Callable[[str, dict, dict], dict],
    model: str = DEFAULT_MODEL,
    chat_url: str = OPENROUTER_URL,
    allow_empty_key: bool = False,
) -> str:
    """One prompt in, raw text out — the agent-mode path
    (unified-expense-os-5kp). The client builds the full prompt (ledger
    digest + action schema) and parses/validates the action itself; the
    server is a dumb relay to the configured provider and never interprets
    the content."""
    if not api_key and not allow_empty_key:
        raise LlmChatIntentUnavailableError("no_api_key_configured")
    payload = {
        "model": model,
        "max_tokens": 700,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = poster(chat_url, payload, headers)
    content = body["choices"][0]["message"]["content"]
    return content if isinstance(content, str) else ""


def http_poster(url: str, payload: dict, headers: dict) -> dict:
    """Real network implementation of HttpPoster, kept separate from
    chat_intent_via_llm so tests can inject a fake and never touch the
    network."""
    import httpx

    response = httpx.post(url, json=payload, headers=headers, timeout=60.0)
    response.raise_for_status()
    return response.json()


def chat_intent_via_llm(
    messages: list[dict],
    context_names: list[str],
    participant_names: list[str],
    category_names: list[str],
    api_key: str,
    poster: Callable[[str, dict, dict], dict],
    model: str = DEFAULT_MODEL,
    chat_url: str = OPENROUTER_URL,
    allow_empty_key: bool = False,
) -> ChatIntentResult:
    if not api_key and not allow_empty_key:
        raise LlmChatIntentUnavailableError("no_api_key_configured")
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(
        context_names=json.dumps(context_names),
        participant_names=json.dumps(participant_names),
        category_names=json.dumps(category_names),
    )
    payload = {
        "model": model,
        "max_tokens": 600,
        "messages": [{"role": "system", "content": system_prompt}]
        + [{"role": m["role"], "content": m["content"]} for m in messages],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = poster(chat_url, payload, headers)
    content = body["choices"][0]["message"]["content"]
    return parse_chat_intent_response(content)
