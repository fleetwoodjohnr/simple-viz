# Contributing

```
npm ci                 # also downloads this platform's DuckDB extensions (checked against scripts/duckdb-extensions.lock.json)
npm run dev            # the app with hot reload
npm run fixtures       # rebuild tests/fixtures (deterministic)
```

**Definition of done:** the feature works, is reachable in the UI, is covered by a passing automated test, and its
limits are written down (IMPLEMENTATION_STATUS.md, docs/). A button that exists in the UI does not count.

Before committing:

```
npm run typecheck && npm test && npm run test:integration && npm run e2e:headless
```

Integration and end-to-end tests that need PostgreSQL start a `postgres:17-alpine` container with podman, or use
`SV_PG_HOST`/`SV_PG_PORT`/`SV_PG_USER`/`SV_PG_PASSWORD`/`SV_PG_DATABASE`. Without either they are skipped and say so.
