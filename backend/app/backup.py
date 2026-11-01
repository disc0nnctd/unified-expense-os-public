from __future__ import annotations

import sqlite3
from pathlib import Path


class UnsupportedDatabaseError(Exception):
    """Raised for non-SQLite DATABASE_URLs — Postgres deployments should use
    pg_dump/pg_restore instead; this module deliberately doesn't wrap those
    (different auth/network model, out of scope here)."""


def _sqlite_path_from_url(database_url: str) -> Path:
    if not database_url.startswith("sqlite:///"):
        raise UnsupportedDatabaseError(database_url)
    return Path(database_url.removeprefix("sqlite:///"))


def backup_database(database_url: str, dest_path: Path) -> Path:
    """Uses SQLite's online backup API (not a file copy) so a backup taken
    while the server is running never captures a torn/partial write."""
    source_path = _sqlite_path_from_url(database_url)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    source_conn = sqlite3.connect(source_path)
    dest_conn = sqlite3.connect(dest_path)
    try:
        source_conn.backup(dest_conn)
    finally:
        source_conn.close()
        dest_conn.close()
    return dest_path


def restore_database(database_url: str, source_backup_path: Path) -> Path:
    """Restores by copying the backup file's contents into a fresh
    connection at the target path via SQLite's backup API — the inverse of
    backup_database, same non-torn-write guarantee. Overwrites the target."""
    target_path = _sqlite_path_from_url(database_url)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    backup_conn = sqlite3.connect(source_backup_path)
    target_conn = sqlite3.connect(target_path)
    try:
        backup_conn.backup(target_conn)
    finally:
        backup_conn.close()
        target_conn.close()
    return target_path


def _main() -> None:
    import argparse
    import os

    parser = argparse.ArgumentParser(description="SQLite backup/restore for the expense-os backend.")
    parser.add_argument("action", choices=["backup", "restore"])
    parser.add_argument("path", help="Backup file path to write to (backup) or read from (restore)")
    args = parser.parse_args()

    database_url = os.getenv("DATABASE_URL", "sqlite:///./expense_os.db")
    from pathlib import Path

    if args.action == "backup":
        backup_database(database_url, Path(args.path))
        print(f"Backed up {database_url} -> {args.path}")
    else:
        restore_database(database_url, Path(args.path))
        print(f"Restored {args.path} -> {database_url}")


if __name__ == "__main__":
    _main()
