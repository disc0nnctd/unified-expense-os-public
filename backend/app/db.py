from __future__ import annotations

import hashlib
import os
from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session, declarative_base, sessionmaker


DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./expense_os.db")
CONNECT_ARGS = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, future=True, connect_args=CONNECT_ARGS)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


def ensure_runtime_schema() -> None:
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    if "contexts" in existing_tables:
        context_columns = {column["name"] for column in inspector.get_columns("contexts")}
        if "allow_simplified_debts" not in context_columns:
            with engine.begin() as connection:
                connection.execute(
                    text("ALTER TABLE contexts ADD COLUMN allow_simplified_debts BOOLEAN NOT NULL DEFAULT FALSE")
                )
    if "memberships" in existing_tables:
        membership_columns = {column["name"] for column in inspector.get_columns("memberships")}
        if "allow_simplify_for_me" not in membership_columns:
            with engine.begin() as connection:
                connection.execute(
                    text("ALTER TABLE memberships ADD COLUMN allow_simplify_for_me BOOLEAN NOT NULL DEFAULT TRUE")
                )
    if "participants" in existing_tables:
        participant_columns = {column["name"] for column in inspector.get_columns("participants")}
        # participants.auth_token is dead: authentication reads only
        # device_tokens.token_hash. The old block here *added* the column on
        # fresh installs and minted plaintext tokens into it, which defeated
        # the point of hashing device tokens at rest. Drop it wherever it
        # still exists (unified-expense-os-apt).
        if "auth_token" in participant_columns:
            with engine.begin() as connection:
                connection.execute(text("DROP INDEX IF EXISTS ix_participants_auth_token"))
                connection.execute(text("ALTER TABLE participants DROP COLUMN auth_token"))
    if "invites" in existing_tables:
        invite_columns = {column["name"] for column in inspector.get_columns("invites")}
        if "claim_participant_id" not in invite_columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE invites ADD COLUMN claim_participant_id TEXT"))
    if "device_tokens" in existing_tables:
        device_token_columns = {column["name"] for column in inspector.get_columns("device_tokens")}
        if "token_hash" not in device_token_columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE device_tokens ADD COLUMN token_hash TEXT"))
                rows = connection.execute(text("SELECT device_token_id, token FROM device_tokens")).all()
                for device_token_id, token in rows:
                    connection.execute(
                        text("UPDATE device_tokens SET token_hash = :hash WHERE device_token_id = :id"),
                        {"hash": hashlib.sha256(token.encode()).hexdigest(), "id": device_token_id},
                    )
                connection.execute(
                    text("CREATE UNIQUE INDEX IF NOT EXISTS ix_device_tokens_token_hash ON device_tokens (token_hash)")
                )
                # Drop the plaintext column entirely — a hash it was derived from
                # is useless to an attacker with DB/backup access, but the raw
                # value sitting alongside it would defeat the whole point. The
                # old unique index on it must go first or SQLite refuses the drop.
                connection.execute(text("DROP INDEX IF EXISTS ix_device_tokens_token"))
                connection.execute(text("ALTER TABLE device_tokens DROP COLUMN token"))
    if "recurring_templates" in existing_tables:
        template_columns = {column["name"] for column in inspector.get_columns("recurring_templates")}
        with engine.begin() as connection:
            if "version" not in template_columns:
                connection.execute(
                    text("ALTER TABLE recurring_templates ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
                )
            if "updated_at" not in template_columns:
                connection.execute(text("ALTER TABLE recurring_templates ADD COLUMN updated_at TIMESTAMP"))
                connection.execute(text("UPDATE recurring_templates SET updated_at = created_at WHERE updated_at IS NULL"))
    if "ledger_entries" in existing_tables:
        entry_columns = {column["name"] for column in inspector.get_columns("ledger_entries")}
        if "notes" not in entry_columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE ledger_entries ADD COLUMN notes TEXT"))
    if "entry_history" in existing_tables:
        history_columns = {column["name"] for column in inspector.get_columns("entry_history")}
        if "notes" not in history_columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE entry_history ADD COLUMN notes TEXT"))
    if "sync_counters" in existing_tables and "ledger_entries" in existing_tables:
        with engine.begin() as connection:
            counter = connection.execute(
                text("SELECT value FROM sync_counters WHERE counter_id = 'server_seq'")
            ).first()
            if counter is None:
                max_seq = connection.execute(
                    text("SELECT COALESCE(MAX(server_seq), 0) FROM ledger_entries")
                ).scalar()
                connection.execute(
                    text("INSERT INTO sync_counters (counter_id, value) VALUES ('server_seq', :value)"),
                    {"value": int(max_seq or 0)},
                )


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
