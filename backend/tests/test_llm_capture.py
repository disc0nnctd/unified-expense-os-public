import pytest

from app.llm_capture import (
    LlmCaptureUnavailableError,
    draft_capture_via_llm,
    parse_llm_capture_response,
)

CANNED_RESPONSE = (
    "```json\n"
    "{\n"
    '  "description": "Dinner with Raj and Priya",\n'
    '  "amount_paise": 250000,\n'
    '  "category": "food",\n'
    '  "participants": ["Raj", "Priya"]\n'
    "}\n"
    "```"
)


def test_parses_canned_markdown_fenced_response():
    draft = parse_llm_capture_response(CANNED_RESPONSE)
    assert draft.description == "Dinner with Raj and Priya"
    assert draft.amount_paise == 250000
    assert draft.category == "food"
    assert draft.participants == ["Raj", "Priya"]


def test_parses_content_without_markdown_fence():
    draft = parse_llm_capture_response(
        '{"description": "Cab", "amount_paise": 40000, "category": null, "participants": []}'
    )
    assert draft.description == "Cab"
    assert draft.category is None
    assert draft.participants == []


def test_draft_capture_via_llm_uses_injected_poster():
    calls = []

    def fake_poster(url, payload, headers):
        calls.append((url, payload, headers))
        return {"choices": [{"message": {"content": CANNED_RESPONSE}}]}

    draft = draft_capture_via_llm("dinner w raj and priya 2500", api_key="test-key", poster=fake_poster)
    assert draft.description == "Dinner with Raj and Priya"
    assert len(calls) == 1
    url, payload, headers = calls[0]
    assert headers["Authorization"] == "Bearer test-key"
    assert payload["model"] == "google/gemma-3-4b-it"


def test_draft_capture_via_llm_requires_api_key():
    with pytest.raises(LlmCaptureUnavailableError):
        draft_capture_via_llm("some text", api_key="", poster=lambda *a: {})


def test_draft_capture_via_llm_allows_empty_key_when_flagged():
    def fake_poster(url, payload, headers):
        assert "Authorization" not in headers
        assert url == "http://localhost:8080/v1/chat/completions"
        return {"choices": [{"message": {"content": CANNED_RESPONSE}}]}

    draft = draft_capture_via_llm(
        "dinner 2500",
        api_key="",
        poster=fake_poster,
        chat_url="http://localhost:8080/v1/chat/completions",
        allow_empty_key=True,
    )
    assert draft.description == "Dinner with Raj and Priya"


def test_parses_extended_split_fields():
    draft = parse_llm_capture_response(
        '{"description": "Goa dinner", "amount_paise": 45000, "category": "food", '
        '"participants": ["Asha", "Ravi"], "payer": "Asha", "split_mode": "shares", '
        '"shares": {"Asha": 2, "Ravi": 1}, "amounts_paise": null, '
        '"context_hint": "Goa trip", "date": "2026-07-20"}'
    )
    assert draft.payer == "Asha"
    assert draft.split_mode == "shares"
    assert draft.shares == {"Asha": 2.0, "Ravi": 1.0}
    assert draft.amounts_paise is None
    assert draft.context_hint == "Goa trip"
    assert draft.date == "2026-07-20"


def test_extended_fields_default_to_none_on_old_shape_responses():
    draft = parse_llm_capture_response(
        '{"description": "Cab", "amount_paise": 40000, "category": null, "participants": []}'
    )
    assert draft.payer is None
    assert draft.split_mode is None
    assert draft.shares is None
    assert draft.amounts_paise is None
    assert draft.context_hint is None
    assert draft.date is None


def test_extended_fields_tolerate_garbage_values():
    draft = parse_llm_capture_response(
        '{"description": "X", "amount_paise": 100, "category": null, "participants": [], '
        '"split_mode": "fifty-fifty", "shares": "half each", '
        '"amounts_paise": {"Asha": "not-a-number"}, "payer": null}'
    )
    assert draft.split_mode is None
    assert draft.shares is None
    assert draft.amounts_paise is None


def test_custom_amounts_map_parses_ints():
    draft = parse_llm_capture_response(
        '{"description": "Lunch", "amount_paise": 45000, "category": null, '
        '"participants": ["Asha", "Ravi"], "split_mode": "custom", '
        '"amounts_paise": {"Asha": 30000, "Ravi": 15000}}'
    )
    assert draft.split_mode == "custom"
    assert draft.amounts_paise == {"Asha": 30000, "Ravi": 15000}


def test_currency_field_validated_as_iso_alpha_code():
    draft = parse_llm_capture_response(
        '{"description": "GPU", "amount_paise": 250000, "category": null, '
        '"participants": ["Gunjan"], "currency": "usd"}'
    )
    assert draft.currency == "USD"


def test_currency_garbage_collapses_to_none():
    for bad in ('"dollars"', '"$"', "123", "null", '"USDX"'):
        draft = parse_llm_capture_response(
            '{"description": "X", "amount_paise": 100, "category": null, '
            f'"participants": [], "currency": {bad}}}'
        )
        assert draft.currency is None
