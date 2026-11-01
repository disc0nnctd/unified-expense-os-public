import json

import pytest

from app.llm_chat_intent import (
    GENERIC_CLARIFY_QUESTION,
    LlmChatIntentUnavailableError,
    chat_intent_via_llm,
    parse_chat_intent_response,
)


def test_parses_draft_expense_intent():
    result = parse_chat_intent_response(
        '{"intent": "draft_expense", "draft": {"description": "Dinner", '
        '"amount_paise": 45000, "category": "food", "participants": ["Asha", "Ravi"], '
        '"payer": "Asha", "split_mode": "equal", "shares": null, "amounts_paise": null, '
        '"context_hint": "Flat", "date": null}, "query": null, '
        '"clarify_question": null, "reply": "Drafted that for you."}'
    )
    assert result.intent == "draft_expense"
    assert result.draft is not None
    assert result.draft.description == "Dinner"
    assert result.draft.amount_paise == 45000
    assert result.draft.payer == "Asha"
    assert result.draft.split_mode == "equal"
    assert result.draft.context_hint == "Flat"
    assert result.query is None
    assert result.reply == "Drafted that for you."


def test_parses_query_ledger_intent():
    result = parse_chat_intent_response(
        '{"intent": "query_ledger", "draft": null, "query": {"metric": "total spend", '
        '"timeframe": "this month", "category": "groceries", "person": null}, '
        '"clarify_question": null, "reply": null}'
    )
    assert result.intent == "query_ledger"
    assert result.draft is None
    assert result.query is not None
    assert result.query.metric == "total spend"
    assert result.query.timeframe == "this month"
    assert result.query.category == "groceries"
    assert result.query.person is None


def test_markdown_fenced_response_is_parsed():
    result = parse_chat_intent_response(
        '```json\n{"intent": "none", "draft": null, "query": null, '
        '"clarify_question": null, "reply": "Hi!"}\n```'
    )
    assert result.intent == "none"
    assert result.reply == "Hi!"


def test_unparseable_content_coerces_to_clarify():
    result = parse_chat_intent_response("I think you spent about Rs 5000 last month!")
    assert result.intent == "clarify"
    assert result.clarify_question == GENERIC_CLARIFY_QUESTION
    assert result.draft is None
    assert result.query is None


def test_unknown_intent_coerces_to_clarify():
    result = parse_chat_intent_response(
        '{"intent": "delete_everything", "draft": null, "query": null, '
        '"clarify_question": null, "reply": null}'
    )
    assert result.intent == "clarify"
    assert result.clarify_question == GENERIC_CLARIFY_QUESTION


def test_non_object_json_coerces_to_clarify():
    assert parse_chat_intent_response('["a", "list"]').intent == "clarify"


def test_clarify_without_question_gets_generic_question():
    result = parse_chat_intent_response(
        '{"intent": "clarify", "draft": null, "query": null, '
        '"clarify_question": null, "reply": null}'
    )
    assert result.clarify_question == GENERIC_CLARIFY_QUESTION


def test_draft_ignored_for_non_draft_intents():
    result = parse_chat_intent_response(
        '{"intent": "none", "draft": {"description": "sneaky", "participants": []}, '
        '"query": {"metric": "x", "timeframe": null, "category": null, "person": null}, '
        '"clarify_question": null, "reply": "ok"}'
    )
    assert result.draft is None
    assert result.query is None


def test_chat_intent_via_llm_uses_injected_poster_and_system_prompt():
    calls = []

    def fake_poster(url, payload, headers):
        calls.append((url, payload, headers))
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"intent": "none", "draft": null, "query": null, '
                        '"clarify_question": null, "reply": "Hello!"}'
                    }
                }
            ]
        }

    result = chat_intent_via_llm(
        [{"role": "user", "content": "hi"}],
        context_names=["Flat", "Goa trip"],
        participant_names=["Asha", "Ravi"],
        category_names=["food"],
        api_key="test-key",
        poster=fake_poster,
    )
    assert result.intent == "none"
    url, payload, headers = calls[0]
    assert headers["Authorization"] == "Bearer test-key"
    system = payload["messages"][0]
    assert system["role"] == "system"
    assert json.dumps(["Flat", "Goa trip"]) in system["content"]
    assert json.dumps(["Asha", "Ravi"]) in system["content"]
    assert payload["messages"][1] == {"role": "user", "content": "hi"}


def test_chat_intent_via_llm_requires_api_key():
    with pytest.raises(LlmChatIntentUnavailableError):
        chat_intent_via_llm(
            [{"role": "user", "content": "hi"}],
            context_names=[],
            participant_names=[],
            category_names=[],
            api_key="",
            poster=lambda *a: {},
        )


def test_chat_intent_via_llm_allows_empty_key_when_flagged():
    def fake_poster(url, payload, headers):
        assert "Authorization" not in headers
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"intent": "none", "draft": null, "query": null, '
                        '"clarify_question": null, "reply": "Hi"}'
                    }
                }
            ]
        }

    result = chat_intent_via_llm(
        [{"role": "user", "content": "hi"}],
        context_names=[],
        participant_names=[],
        category_names=[],
        api_key="",
        poster=fake_poster,
        allow_empty_key=True,
    )
    assert result.intent == "none"
