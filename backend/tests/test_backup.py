import sqlite3

import pytest

from app.backup import UnsupportedDatabaseError, backup_database, restore_database


def _make_db(path, rows):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)")
    conn.executemany("INSERT INTO items (name) VALUES (?)", [(row,) for row in rows])
    conn.commit()
    conn.close()


def test_backup_then_restore_round_trips_data(tmp_path):
    source_path = tmp_path / "source.db"
    _make_db(source_path, ["alpha", "beta"])

    backup_path = tmp_path / "backup.db"
    backup_database(f"sqlite:///{source_path}", backup_path)

    # Mutate the source after backup — restore should bring back the
    # pre-mutation state, proving the backup is an independent snapshot.
    conn = sqlite3.connect(source_path)
    conn.execute("DELETE FROM items")
    conn.commit()
    conn.close()

    restore_target = tmp_path / "restored.db"
    restore_database(f"sqlite:///{restore_target}", backup_path)

    conn = sqlite3.connect(restore_target)
    names = [row[0] for row in conn.execute("SELECT name FROM items ORDER BY id")]
    conn.close()
    assert names == ["alpha", "beta"]


def test_non_sqlite_url_is_rejected(tmp_path):
    with pytest.raises(UnsupportedDatabaseError):
        backup_database("postgresql://user:pass@host/db", tmp_path / "out.db")
