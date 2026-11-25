# Wisebase Node.js Backend

Standalone Node.js migration target for the existing Wisebase Directus endpoint extension.

## Current state

This migration currently contains implementations (some intentionally partial) for all 20 routes identified in the compiled Directus extension, plus an Express server, PostgreSQL connectivity, health/readiness checks, JWT identity middleware, and unit tests. Route presence is not proof of full Directus parity; see the route inventory for outstanding integration gates.

**This is not yet a production-ready Directus replacement.** All 20 inventoried routes have at least partial implementations, but several still have deliberate gaps and none has completed live schema/tenant/concurrency parity verification. The current production Directus extension must remain in service until those gates pass.

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
- `GET /workspaces/invites/:inviteId`: retrieve an in-app invitation for its invited account
- `GET /organization`: retrieve the active organization profile, departments, members, invites and permissions (Owner/HR only)\n- `PATCH /organization/profile`: update the active organization profile (owner only)
- `POST /organization/departments`: create a department (Owner/HR only)\n- `PATCH /organization/departments/:departmentId`: update its name or manager (Owner/HR only)\n- `POST /organization/departments/:departmentId/deactivate`: deactivate an empty department (Owner/HR only)
- `POST /workspaces/invites`: create an in-app invitation for an existing account (email delivery for unknown accounts still requires the Directus mail flow)
- `POST /workspaces/invites/:inviteId/accept`: accept an invitation and create membership
- `POST /workspaces/invites/:inviteId/decline`: decline an invitation
- `POST /workspaces/create`: create a workspace and owner membership (requires a valid API bearer token and role UUID configuration)
- `GET /workforce`: retrieve the role-scoped workforce roster and scan-request summary
- `POST /scan-requests`, `GET /scan-requests`: create and list workspace-scoped scan requests
- `POST /alerts/:alertId/workflow`: apply supported alert lifecycle transitions
- `POST /avatar`, `GET /files/:fileId`: upload avatar and deliver authorized private avatar files
- `POST /account-deletion-requests`: submit an account deletion request (staff notification only; does not delete the account)

## Authentication configuration

Set `AUTH_MODE=directus` to validate each bearer access token against the configured Directus instance using `GET /users/me`, then confirm that identity is still active in the local `directus_users` table. This supports Directus bearer access tokens; it does not automatically support browser session cookies, refresh-token renewal, or frontend CORS/cookie deployment. The default `AUTH_MODE=standalone` accepts only HS256 tokens with `AUTH_JWT_SECRET`, optional issuer/audience checks, UUID `sub`, mandatory `iat`/`exp`, and a maximum 24-hour lifetime. Database failures are surfaced as server errors. Never switch production traffic until the frontend token lifecycle and cross-origin deployment have been integration-tested.

Configure the four `WELLAR_*_ROLE_ID` variables with distinct existing Directus role UUIDs.

## Migration principles

1. Preserve externally observable API behavior, not Directus internals.
2. Reimplement authentication explicitly; never trust client-supplied user/workspace IDs.
3. Enforce workspace scoping in every query and mutation.
4. Preserve transaction, locking, idempotency, audit and rollback guarantees.
5. Test authorization, cross-tenant access, concurrency and external side effects.
6. Mark routes complete only after parity tests pass.

See [the route inventory](docs/route-inventory.md) and [PostgreSQL integration checks](docs/integration-testing.md). Set `TRUST_PROXY` to the exact trusted proxy hop count when running behind a reverse proxy; do not trust arbitrary forwarded headers.
