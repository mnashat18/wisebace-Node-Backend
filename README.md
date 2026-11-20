# WisePace Node.js Backend

Standalone Node.js migration target for the existing WisePace Directus endpoint extension.

## Current state

This is the initial migration scaffold. It includes a hardened Express server, PostgreSQL connectivity, health/readiness checks, and a route inventory based on the compiled Directus artifact supplied for this task.

**This is not a completed Directus replacement.** Business routes are intentionally not faked; requests to routes not yet migrated return `501`. The current production Directus extension must remain in service until parity is complete.

## Requirements

- Node.js 22+
- PostgreSQL

## Run locally

```bash
cp .env.example .env
npm install
npm run dev
```

- `GET /health`: process health
- `GET /ready`: PostgreSQL readiness (requires `DATABASE_URL`)

## Migration principles

1. Preserve externally observable API behavior, not Directus internals.
2. Reimplement authentication explicitly; never trust client-supplied user/workspace IDs.
3. Enforce workspace scoping in every query and mutation.
4. Preserve transaction, locking, idempotency, audit and rollback guarantees.
5. Test authorization, cross-tenant access, concurrency and external side effects.
6. Mark routes complete only after parity tests pass.

See [the route inventory](docs/route-inventory.md).
