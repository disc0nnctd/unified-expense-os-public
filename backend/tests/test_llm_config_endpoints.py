from datetime import UTC, datetime

from tests.test_api import auth_header, register_participant

_ENV_VARS = [
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_API_KEY",
    "LLM_API_KEY_OPTIONAL",
    "OPENROUTER_API_KEY",
    "LLM_ALLOW_PRIVATE",
]


def _clear_llm_env(monkeypatch):
    for var in _ENV_VARS:
        monkeypatch.delenv(var, raising=False)


def _allow_private_llm_targets(monkeypatch):
    """Opt into LAN/private inference targets, as a self-hoster pointing the
    assist endpoints at a llama-server on their own network would."""
    monkeypatch.setenv("LLM_ALLOW_PRIVATE", "1")


def test_llm_config_requires_auth(client):
    assert client.get("/me/llm-config").status_code == 401
    assert client.put("/me/llm-config", json={"base_url": "https://x.example/v1", "model": "m"}).status_code == 401
    assert client.delete("/me/llm-config").status_code == 401


def test_llm_config_crud_roundtrip(client, monkeypatch):
    _allow_private_llm_targets(monkeypatch)
    token = register_participant(client, "alice", "Alice", datetime.now(UTC).isoformat())

    # Before any PUT: unconfigured shape.
    response = client.get("/me/llm-config", headers=auth_header(token))
    assert response.status_code == 200
    assert response.json() == {
        "configured": False,
        "base_url": None,
        "model": None,
        "has_api_key": False,
    }

    # PUT with a key: configured, key acknowledged but never echoed.
    response = client.put(
        "/me/llm-config",
        json={
            "base_url": "https://integrate.api.nvidia.com/v1",
            "model": "meta/llama-3.1-8b-instruct",
            "api_key": "nvapi-secret",
        },
        headers=auth_header(token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "configured": True,
        "base_url": "https://integrate.api.nvidia.com/v1",
        "model": "meta/llama-3.1-8b-instruct",
        "has_api_key": True,
    }
    assert "nvapi-secret" not in response.text

    response = client.get("/me/llm-config", headers=auth_header(token))
    assert response.json()["has_api_key"] is True
    assert "api_key" not in response.json()
    assert "nvapi-secret" not in response.text

    # PUT with api_key omitted: model changes, stored key survives.
    response = client.put(
        "/me/llm-config",
        json={"base_url": "https://integrate.api.nvidia.com/v1", "model": "meta/llama-3.3-70b-instruct"},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    assert response.json()["model"] == "meta/llama-3.3-70b-instruct"
    assert response.json()["has_api_key"] is True

    # PUT with api_key "": clears to keyless.
    response = client.put(
        "/me/llm-config",
        json={"base_url": "http://192.168.1.5:8080/v1", "model": "local-model", "api_key": ""},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    assert response.json()["has_api_key"] is False
    assert response.json()["configured"] is True

    # DELETE reverts to unconfigured (env fallback).
    response = client.delete("/me/llm-config", headers=auth_header(token))
    assert response.status_code == 204
    response = client.get("/me/llm-config", headers=auth_header(token))
    assert response.json()["configured"] is False


def test_llm_config_rejects_non_http_base_url(client):
    token = register_participant(client, "bob", "Bob", datetime.now(UTC).isoformat())
    response = client.put(
        "/me/llm-config",
        json={"base_url": "ftp://example.com/v1", "model": "m", "api_key": "k"},
        headers=auth_header(token),
    )
    assert response.status_code == 422


def test_llm_config_rejects_private_targets_by_default(client, monkeypatch):
    # Without LLM_ALLOW_PRIVATE the endpoint must not become an SSRF probe:
    # a household member should not be able to make the server call the
    # metadata service, the docker network, or its own loopback.
    _clear_llm_env(monkeypatch)
    token = register_participant(client, "mallory", "Mallory", datetime.now(UTC).isoformat())
    for base_url in (
        "http://169.254.169.254/latest/v1",
        "http://192.168.1.5:8080/v1",
        "http://10.0.0.7/v1",
        "http://127.0.0.1:8000/v1",
        "http://localhost:8000/v1",
        "http://[::1]:8000/v1",
    ):
        response = client.put(
            "/me/llm-config",
            json={"base_url": base_url, "model": "m", "api_key": "k"},
            headers=auth_header(token),
        )
        assert response.status_code == 422, base_url
        assert response.json()["detail"] == "base_url_private_not_allowed"

    # A public provider URL is still accepted.
    assert (
        client.put(
            "/me/llm-config",
            json={"base_url": "https://openrouter.ai/api/v1", "model": "m", "api_key": "k"},
            headers=auth_header(token),
        ).status_code
        == 200
    )


def test_stored_private_config_stops_working_when_operator_tightens_setting(client, monkeypatch):
    # A config stored while private targets were allowed must not keep working
    # as an SSRF path after the operator turns the allowance off.
    _clear_llm_env(monkeypatch)
    _allow_private_llm_targets(monkeypatch)
    token = register_participant(client, "nate", "Nate", datetime.now(UTC).isoformat())
    assert (
        client.put(
            "/me/llm-config",
            json={"base_url": "http://192.168.1.5:8080/v1", "model": "local-model", "api_key": ""},
            headers=auth_header(token),
        ).status_code
        == 200
    )

    monkeypatch.delenv("LLM_ALLOW_PRIVATE", raising=False)
    response = client.post(
        "/capture/parse-nl-fallback",
        json={"text": "cab 400"},
        headers=auth_header(token),
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "base_url_private_not_allowed"


def test_llm_endpoint_uses_participant_config_over_env(client, monkeypatch):
    _clear_llm_env(monkeypatch)
    seen = {}

    def fake_poster(url, payload, headers):
        seen["url"] = url
        seen["model"] = payload["model"]
        seen["authorization"] = headers.get("Authorization")
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

    token = register_participant(client, "carol", "Carol", datetime.now(UTC).isoformat())
    response = client.put(
        "/me/llm-config",
        json={
            "base_url": "https://openrouter.ai/api/v1/",
            "model": "qwen/qwen3-8b",
            "api_key": "sk-or-personal",
        },
        headers=auth_header(token),
    )
    assert response.status_code == 200

    # No env key set anywhere, yet the stored config makes the call work —
    # and the poster sees the participant's provider, model, and key.
    response = client.post(
        "/capture/parse-nl-fallback",
        json={"text": "cab 400"},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    assert seen["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert seen["model"] == "qwen/qwen3-8b"
    assert seen["authorization"] == "Bearer sk-or-personal"


def test_llm_endpoint_falls_back_to_env_without_stored_config(client, monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("LLM_BASE_URL", "http://envhost:8080/v1")
    monkeypatch.setenv("LLM_MODEL", "env-model")
    monkeypatch.setenv("LLM_API_KEY", "env-key")
    seen = {}

    def fake_poster(url, payload, headers):
        seen["url"] = url
        seen["model"] = payload["model"]
        seen["authorization"] = headers.get("Authorization")
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

    token = register_participant(client, "dave", "Dave", datetime.now(UTC).isoformat())
    response = client.post(
        "/capture/parse-nl-fallback",
        json={"text": "cab 400"},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    assert seen["url"] == "http://envhost:8080/v1/chat/completions"
    assert seen["model"] == "env-model"
    assert seen["authorization"] == "Bearer env-key"


def test_stored_keyless_config_does_not_503(client, monkeypatch):
    _clear_llm_env(monkeypatch)
    _allow_private_llm_targets(monkeypatch)
    seen = {}

    def fake_poster(url, payload, headers):
        seen["url"] = url
        seen["headers"] = headers
        return {
            "choices": [
                {"message": {"content": '{"category": "groceries", "split_hint": "even", "confidence": "medium"}'}}
            ]
        }

    import app.main as main_module

    monkeypatch.setattr(main_module, "llm_coldstart_http_poster", fake_poster)

    token = register_participant(client, "erin", "Erin", datetime.now(UTC).isoformat())
    response = client.put(
        "/me/llm-config",
        json={"base_url": "http://192.168.1.5:8080/v1", "model": "local-model", "api_key": ""},
        headers=auth_header(token),
    )
    assert response.status_code == 200

    # A stored keyless config behaves like keyless-LAN mode: no 503, no
    # Authorization header on the outbound request.
    response = client.post(
        "/capture/coldstart-suggest",
        json={"text": "veggies for the flat"},
        headers=auth_header(token),
    )
    assert response.status_code == 200
    assert seen["url"] == "http://192.168.1.5:8080/v1/chat/completions"
    assert "Authorization" not in seen["headers"]


def test_stored_config_is_per_participant(client, monkeypatch):
    _clear_llm_env(monkeypatch)
    _allow_private_llm_targets(monkeypatch)
    now = datetime.now(UTC).isoformat()
    frank_token = register_participant(client, "frank", "Frank", now)
    grace_token = register_participant(client, "grace", "Grace", now)

    response = client.put(
        "/me/llm-config",
        json={"base_url": "http://192.168.1.5:8080/v1", "model": "local-model", "api_key": ""},
        headers=auth_header(frank_token),
    )
    assert response.status_code == 200

    # Grace has no stored config and no env key: still 503, unaffected by
    # Frank's config.
    response = client.post(
        "/capture/parse-nl-fallback",
        json={"text": "cab 400"},
        headers=auth_header(grace_token),
    )
    assert response.status_code == 503
    assert client.get("/me/llm-config", headers=auth_header(grace_token)).json()["configured"] is False
