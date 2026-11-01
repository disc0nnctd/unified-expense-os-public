from datetime import UTC, datetime

from tests.test_api import auth_header, register_participant


def test_parse_nl_capture_fallback_returns_draft(client, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    def fake_poster(url, payload, headers):
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"description": "Cab to airport", "amount_paise": 60000, "category": "travel", "participants": ["Alice"]}'
                    }
                }
            ]
        }

    import app.main as main_module

    monkeypatch.setattr(main_module, "llm_capture_http_poster", fake_poster)

    token = register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())
    response = client.post(
        "/capture/parse-nl-fallback",
        json={"text": "cab to airport 600"},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["description"] == "Cab to airport"
    assert body["amount_paise"] == 60000
    assert body["participants"] == ["Alice"]


def test_parse_nl_capture_fallback_returns_extended_split_fields(client, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    def fake_poster(url, payload, headers):
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"description": "Goa dinner", "amount_paise": 45000, '
                        '"category": "food", "participants": ["Asha", "Ravi"], "payer": "Asha", '
                        '"split_mode": "shares", "shares": {"Asha": 2, "Ravi": 1}, '
                        '"amounts_paise": null, "context_hint": "Goa trip", "date": "2026-07-20"}'
                    }
                }
            ]
        }

    import app.main as main_module

    monkeypatch.setattr(main_module, "llm_capture_http_poster", fake_poster)

    token = register_participant(client, "asha2", "Asha", datetime.now(UTC).isoformat())
    response = client.post(
        "/capture/parse-nl-fallback",
        json={"text": "dinner in goa 450, I paid, split 2 to 1 with ravi"},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["payer"] == "Asha"
    assert body["split_mode"] == "shares"
    assert body["shares"] == {"Asha": 2.0, "Ravi": 1.0}
    assert body["context_hint"] == "Goa trip"
    assert body["date"] == "2026-07-20"


def test_parse_nl_capture_fallback_old_shape_response_still_works(client, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    def fake_poster(url, payload, headers):
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"description": "Cab", "amount_paise": 40000, '
                        '"category": null, "participants": []}'
                    }
                }
            ]
        }

    import app.main as main_module

    monkeypatch.setattr(main_module, "llm_capture_http_poster", fake_poster)

    token = register_participant(client, "ravi2", "Ravi", datetime.now(UTC).isoformat())
    response = client.post(
        "/capture/parse-nl-fallback",
        json={"text": "cab 400"},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["payer"] is None
    assert body["split_mode"] is None
    assert body["shares"] is None


def test_parse_nl_capture_fallback_requires_auth(client):
    response = client.post("/capture/parse-nl-fallback", json={"text": "cab 600"})
    assert response.status_code == 401


def test_parse_nl_capture_fallback_without_api_key_returns_503(client, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY_OPTIONAL", raising=False)
    token = register_participant(client, "bob", "Bob", datetime.now(UTC).isoformat())
    response = client.post(
        "/capture/parse-nl-fallback",
        json={"text": "cab 600"},
        headers=auth_header(token),
    )
    assert response.status_code == 503


def test_coldstart_suggest_returns_suggestion(client, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    def fake_poster(url, payload, headers):
        return {
            "choices": [
                {"message": {"content": '{"category": "groceries", "split_hint": "even", "confidence": "medium"}'}}
            ]
        }

    import app.main as main_module

    monkeypatch.setattr(main_module, "llm_coldstart_http_poster", fake_poster)

    token = register_participant(client, "carol", "Carol", datetime.now(UTC).isoformat())
    response = client.post(
        "/capture/coldstart-suggest",
        json={"text": "bought veggies for the new flat"},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["category"] == "groceries"
    assert body["split_hint"] == "even"


def test_coldstart_suggest_requires_auth(client):
    response = client.post("/capture/coldstart-suggest", json={"text": "veggies"})
    assert response.status_code == 401


def test_coldstart_suggest_without_api_key_returns_503(client, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY_OPTIONAL", raising=False)
    token = register_participant(client, "dave", "Dave", datetime.now(UTC).isoformat())
    response = client.post(
        "/capture/coldstart-suggest",
        json={"text": "veggies"},
        headers=auth_header(token),
    )
    assert response.status_code == 503
