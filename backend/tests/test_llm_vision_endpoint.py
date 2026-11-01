from datetime import UTC, datetime

from tests.test_api import auth_header, register_participant


def test_parse_receipt_vision_returns_draft(client, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    def fake_poster(url, payload, headers):
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"merchant": "Test Shop", "date": "2026-07-12", "total_paise": 5000, "items": [{"label": "Milk", "amount_paise": 5000}]}'
                    }
                }
            ]
        }

    import app.main as main_module

    monkeypatch.setattr(main_module, "http_poster", fake_poster)

    token = register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())
    response = client.post(
        "/capture/parse-receipt-vision",
        json={"image_base64": "ZmFrZWltYWdlZGF0YQ=="},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["merchant"] == "Test Shop"
    assert body["total_paise"] == 5000
    assert body["items"] == [{"label": "Milk", "amount_paise": 5000}]


def test_parse_receipt_vision_requires_auth(client):
    response = client.post("/capture/parse-receipt-vision", json={"image_base64": "abc"})
    assert response.status_code == 401


def test_parse_receipt_vision_without_api_key_returns_503(client, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY_OPTIONAL", raising=False)
    token = register_participant(client, "bob", "Bob", datetime.now(UTC).isoformat())
    response = client.post(
        "/capture/parse-receipt-vision",
        json={"image_base64": "abc"},
        headers=auth_header(token),
    )
    assert response.status_code == 503
