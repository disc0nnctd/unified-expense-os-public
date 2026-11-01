import pytest

from app.llm_coldstart import (
    LlmColdStartUnavailableError,
    parse_llm_coldstart_response,
    suggest_coldstart_via_llm,
)

CANNED_RESPONSE = '{"category": "groceries", "split_hint": "even", "confidence": "medium"}'


def test_parses_canned_response():
    suggestion = parse_llm_coldstart_response(CANNED_RESPONSE)
    assert suggestion.category == "groceries"
    assert suggestion.split_hint == "even"
    assert suggestion.confidence == "medium"


def test_parses_markdown_fenced_response():
    fenced = f"```json\n{CANNED_RESPONSE}\n```"
    suggestion = parse_llm_coldstart_response(fenced)
    assert suggestion.category == "groceries"


def test_falls_back_to_unclear_and_low_on_invalid_enum_values():
    suggestion = parse_llm_coldstart_response(
        '{"category": "misc", "split_hint": "fifty-fifty", "confidence": "very high"}'
    )
    assert suggestion.split_hint == "unclear"
    assert suggestion.confidence == "low"


def test_suggest_coldstart_via_llm_uses_injected_poster():
    calls = []

    def fake_poster(url, payload, headers):
        calls.append((url, payload, headers))
        return {"choices": [{"message": {"content": CANNED_RESPONSE}}]}

    suggestion = suggest_coldstart_via_llm("bought veggies for the flat", api_key="test-key", poster=fake_poster)
    assert suggestion.category == "groceries"
    assert len(calls) == 1
    url, payload, headers = calls[0]
    assert headers["Authorization"] == "Bearer test-key"


def test_suggest_coldstart_via_llm_requires_api_key():
    with pytest.raises(LlmColdStartUnavailableError):
        suggest_coldstart_via_llm("text", api_key="", poster=lambda *a: {})
