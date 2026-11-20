# WisePace Node.js Backend

Standalone Node.js migration target for the existing WisePace Directus endpoint extension.

## Current state

This migration includes a hardened Express server, PostgreSQL connectivity, health/readiness checks, JWT identity middleware, and four migrated endpoints: `POST /auth/email-availability`, `GET /workspaces/context`, `POST /workspaces/switch`, and `POST /workspaces/create`.

**This is not a completed Directus replacement.** Routes not yet migrated return `501`. Workspace creation is implemented but still requires live PostgreSQL integration tests and connection to the existing identity provider before production use. The current production Directus extension must remain in service until parity is complete.

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
- `POST /auth/email-availability`: rate-limited email availability check
- `GET /workspaces/context`: list eligible memberships and invitations (requires a valid API bearer token)
- `POST /workspaces/switch`: switch the authenticated user's active workspace (requires a valid API bearer token and role UUID configuration)
- `POST /workspaces/create`: create a workspace and owner membership (requires a valid API bearer token and role UUID configuration)

## Authentication configuration

The current API accepts HS256 bearer tokens configured with `AUTH_JWT_SECRET`, optional issuer/audience checks, and a UUID `sub` claim that resolves to an active row in `directus_users`. This is a new standalone token contract, not a drop-in compatibility claim for Directus cookies or tokens. Do not switch the frontend until its authentication flow is explicitly integrated and tested.

Configure the four `WELLAR_*_ROLE_ID` variables with distinct existing Directus role UUIDs.

## Migration principles

1. Preserve externally observable API behavior, not Directus internals.
2. Reimplement authentication explicitly; never trust client-supplied user/workspace IDs.
3. Enforce workspace scoping in every query and mutation.
4. Preserve transaction, locking, idempotency, audit and rollback guarantees.
5. Test authorization, cross-tenant access, concurrency and external side effects.
6. Mark routes complete only after parity tests pass.

See [the route inventory](docs/route-inventory.md).
