from app.llm_provider import DEFAULT_BASE_URL, DEFAULT_MODEL, resolve_llm_config

_ALL_VARS = ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_API_KEY_OPTIONAL", "OPENROUTER_API_KEY"]


def _clear_env(monkeypatch):
    for var in _ALL_VARS:
        monkeypatch.delenv(var, raising=False)


def test_defaults_to_openrouter(monkeypatch):
    _clear_env(monkeypatch)
    config = resolve_llm_config()
    assert config.chat_url == f"{DEFAULT_BASE_URL}/chat/completions"
    assert config.model == DEFAULT_MODEL
    assert config.api_key == ""
    assert config.key_optional is False
    assert config.is_configured is False


def test_legacy_openrouter_key_still_works(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("OPENROUTER_API_KEY", "legacy-key")
    config = resolve_llm_config()
    assert config.api_key == "legacy-key"
    assert config.is_configured is True


def test_llm_api_key_takes_precedence_over_legacy(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("OPENROUTER_API_KEY", "legacy-key")
    monkeypatch.setenv("LLM_API_KEY", "new-key")
    assert resolve_llm_config().api_key == "new-key"


def test_custom_base_url_and_model(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("LLM_BASE_URL", "http://192.168.1.5:8080/v1/")
    monkeypatch.setenv("LLM_MODEL", "qwen3.5-9b")
    config = resolve_llm_config()
    # Trailing slash on the base URL must not produce a double slash.
    assert config.chat_url == "http://192.168.1.5:8080/v1/chat/completions"
    assert config.model == "qwen3.5-9b"


def test_key_optional_marks_configured_without_key(monkeypatch):
    _clear_env(monkeypatch)
    monkeypatch.setenv("LLM_BASE_URL", "http://localhost:8080/v1")
    monkeypatch.setenv("LLM_API_KEY_OPTIONAL", "1")
    config = resolve_llm_config()
    assert config.api_key == ""
    assert config.key_optional is True
    assert config.is_configured is True
