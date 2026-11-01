# Web Client

Self-hosted local-first PWA for unified personal plus shared household finance.

## Local development

```bash
cd web
npm install
npm run dev
```

If `VITE_API_BASE_URL` is unset, the client targets the current page hostname on
port `8000`. Set `VITE_API_BASE_URL` explicitly if the backend runs on a
different origin.

## Production preview

```bash
cd web
npm run build
npm run preview
```

The client stores its working state in IndexedDB so household data remains usable offline before syncing.
