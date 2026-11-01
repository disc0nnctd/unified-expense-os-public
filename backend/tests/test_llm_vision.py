import pytest

from app.llm_vision import (
    LlmVisionUnavailableError,
    extract_receipt_via_llm,
    parse_llm_response_content,
)

# Captured verbatim from a real OpenRouter call to google/gemma-3-4b-it
# against a real receipt photo (bhimrazy/receipt-ocr's images/receipt.jpg) —
# proves the parser handles the model's actual markdown-fenced output shape,
# not an idealized fixture.
REAL_MODEL_RESPONSE = (
    "```json\n"
    "{\n"
    '  "merchant": "Saathimart.com",\n'
    '  "date": "2024-03-21",\n'
    '  "total_paise": 18500,\n'
    '  "items": [\n'
    "    {\n"
    '      "label": "COLGATE DENTAL",\n'
    '      "amount_paise": 95\n'
    "    },\n"
    "    {\n"
    '      "label": "PATANJALI ANTI",\n'
    '      "amount_paise": 70\n'
    "    },\n"
    "    {\n"
    '      "label": "GODREJ NO",\n'
    '      "amount_paise": 20\n'
    "    }\n"
    "  ]\n"
    "}\n"
    "```"
)


def test_parses_real_captured_model_response():
    draft = parse_llm_response_content(REAL_MODEL_RESPONSE)
    assert draft.merchant == "Saathimart.com"
    assert draft.date == "2024-03-21"
    assert draft.total_paise == 18500
    assert len(draft.items) == 3
    assert draft.items[0] == {"label": "COLGATE DENTAL", "amount_paise": 95}


def test_parses_content_without_markdown_fence():
    draft = parse_llm_response_content('{"merchant": "Shop", "date": null, "total_paise": 100, "items": []}')
    assert draft.merchant == "Shop"
    assert draft.total_paise == 100
    assert draft.items == []


def test_extract_receipt_via_llm_uses_injected_poster():
    calls = []

    def fake_poster(url, payload, headers):
        calls.append((url, payload, headers))
        return {"choices": [{"message": {"content": REAL_MODEL_RESPONSE}}]}

    draft = extract_receipt_via_llm("base64data", api_key="test-key", poster=fake_poster)
    assert draft.merchant == "Saathimart.com"
    assert len(calls) == 1
    url, payload, headers = calls[0]
    assert headers["Authorization"] == "Bearer test-key"
    assert payload["model"] == "google/gemma-3-4b-it"
    assert "base64data" in payload["messages"][0]["content"][1]["image_url"]["url"]


def test_extract_receipt_via_llm_requires_api_key():
    with pytest.raises(LlmVisionUnavailableError):
        extract_receipt_via_llm("base64data", api_key="", poster=lambda *a: {})
