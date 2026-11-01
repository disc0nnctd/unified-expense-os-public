from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING
from urllib.parse import urlparse

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from .models import ParticipantModel

# Central resolution of which OpenAI-compatible chat-completions endpoint the
# opt-in LLM assist modules talk to. Historically this was hardcoded to
# OpenRouter + OPENROUTER_API_KEY; self-hosters can now point the same three
# capture fallbacks (and chat-intent) at any local OpenAI-compatible server
# (llama-server, vLLM, Ollama's /v1, ...) so assist traffic never leaves
# their LAN. Env vars:
#
#   LLM_BASE_URL          base URL up to /v1 (default OpenRouter)
#   LLM_MODEL             model id passed through in the request body
#   LLM_API_KEY           bearer key; falls back to legacy OPENROUTER_API_KEY
#   LLM_API_KEY_OPTIONAL  "1" => endpoints are considered configured with no
#                         key (typical for LAN inference servers)

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "google/gemma-3-4b-it"


class LlmBaseUrlNotAllowed(ValueError):
    """A participant-supplied base URL points somewhere we refuse to call."""


def _private_llm_targets_allowed() -> bool:
    # LAN inference (llama-server/Ollama on the host or another box) is a
    # first-class use case, so private targets are allowed — but only when the
    # operator opts in. Default-deny keeps PUT /me/llm-config from being an
    # authenticated SSRF primitive: without this, any household member could
    # make the server probe 169.254.169.254 or the docker network and read the
    # reply back through the chat-completions response shape
    # (unified-expense-os-vf8).
    return os.getenv("LLM_ALLOW_PRIVATE", "").strip() == "1"


def validate_participant_base_url(base_url: str) -> None:
    """Raise LlmBaseUrlNotAllowed if a participant-supplied base URL resolves
    to a private, loopback, link-local or otherwise internal target while
    LLM_ALLOW_PRIVATE is not set. Hostnames that are not literal IPs are
    allowed through (we do not resolve DNS here — the operator's network is
    the boundary for those)."""
    parsed = urlparse(base_url)
    host = (parsed.hostname or "").strip()
    if not host:
        raise LlmBaseUrlNotAllowed("base_url_host_required")
    if _private_llm_targets_allowed():
        return
    # Bare hostnames that always mean "this machine" are blocked alongside
    # literal IPs; anything else is treated as a public name.
    if host.lower() in {"localhost", "localhost.localdomain", "host.docker.internal"}:
        raise LlmBaseUrlNotAllowed("base_url_private_not_allowed")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return
    if (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_multicast
        or address.is_unspecified
    ):
        raise LlmBaseUrlNotAllowed("base_url_private_not_allowed")


@dataclass(frozen=True)
class LlmConfig:
    chat_url: str
    model: str
    api_key: str
    key_optional: bool

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key) or self.key_optional


def resolve_llm_config() -> LlmConfig:
    base_url = (os.getenv("LLM_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    model = os.getenv("LLM_MODEL") or DEFAULT_MODEL
    api_key = os.getenv("LLM_API_KEY") or os.getenv("OPENROUTER_API_KEY") or ""
    key_optional = os.getenv("LLM_API_KEY_OPTIONAL", "") == "1"
    return LlmConfig(
        chat_url=f"{base_url}/chat/completions",
        model=model,
        api_key=api_key,
        key_optional=key_optional,
    )


def resolve_llm_config_for(participant: ParticipantModel, session: Session) -> LlmConfig:
    """Per-participant resolution: a participant's stored provider config
    (set via PUT /me/llm-config, key held server-side only) takes precedence
    over the env-level config; participants without a row keep the env
    behavior exactly, including 503-when-unconfigured. A stored config with
    an empty/NULL api_key is a deliberate keyless setup (LAN inference
    server), so it maps to key_optional=True rather than "not configured"."""
    from sqlalchemy import select

    from .models import LlmConfigModel

    row = session.scalar(
        select(LlmConfigModel).where(LlmConfigModel.participant_id == participant.participant_id)
    )
    if row is None:
        return resolve_llm_config()
    # Re-checked at call time, not just at write time: rows stored before the
    # gate existed (or while LLM_ALLOW_PRIVATE was set) must not keep working
    # as an SSRF path after the operator tightens the setting.
    validate_participant_base_url(row.base_url)
    api_key = row.api_key or ""
    return LlmConfig(
        chat_url=f"{row.base_url.rstrip('/')}/chat/completions",
        model=row.model,
        api_key=api_key,
        key_optional=not api_key,
    )
