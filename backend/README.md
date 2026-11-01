# Reference Backend

FastAPI reference backend for:

- context and membership CRUD
- ledger event persistence
- offline-first sync endpoints
- recurring-template generation
- deterministic capture suggestions

Default local development uses SQLite for quick startup. The schema and connection layer are PostgreSQL-compatible through `DATABASE_URL`.

## Quick start

```bash
cd backend
uv sync
uv run pytest
uv run uvicorn app.main:app --reload
```

## Environment

- `DATABASE_URL`
  - default: `sqlite:///./expense_os.db`
  - production shape: `postgresql+psycopg://user:pass@host:5432/unified_expense_os`
