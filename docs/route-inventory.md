# Directus extension route inventory

Source: the compiled Directus endpoint artifact uploaded in this conversation. The bundle is built around Directus runtime services and injected dependencies; it is not a standalone Node.js HTTP server.

| Method | Path | Status |
|---|---|---|
| POST | `/auth/email-availability` | Implemented; database integration verification pending |
| POST | `/avatar` | Pending |
| GET | `/files/:fileId` | Pending |
| POST | `/account-deletion-requests` | Pending |
| GET | `/organization` | Pending |
| PATCH | `/organization/profile` | Pending |
| POST | `/organization/departments` | Pending |
| PATCH | `/organization/departments/:departmentId` | Pending |
| POST | `/organization/departments/:departmentId/deactivate` | Pending |
| POST | `/scan-requests` | Pending |
| GET | `/scan-requests` | Pending |
| POST | `/alerts/:alertId/workflow` | Pending |
| GET | `/workforce` | Pending |
| POST | `/workspaces/invites` | Pending |
| GET | `/workspaces/context` | Pending |
| GET | `/workspaces/invites/:inviteId` | Pending |
| POST | `/workspaces/invites/:inviteId/accept` | Pending |
| POST | `/workspaces/invites/:inviteId/decline` | Pending |
| POST | `/workspaces/switch` | Pending |
| POST | `/workspaces/create` | Implemented; integration verification pending |

## Parity gates

- Authentication/session identity matches the current Directus accountability contract.
- Authorization and workspace/tenant isolation are enforced server-side.
- Input allowlists, validation, status codes and response envelopes match the current API.
- Multi-row mutations preserve PostgreSQL transactions, advisory locks, uniqueness/idempotency and rollback behavior.
- Audit events, email, push webhooks and file storage retain explicit failure semantics.
- Positive, negative, cross-tenant and concurrency tests pass before a route is marked migrated.

## Implemented migration slices

`POST /auth/email-availability` has been ported with strict JSON input validation, email normalization, a per-IP 10-requests/minute in-memory rate limit, a no-store response, and a 250ms minimum response time. Unit tests cover its normalization rules.

### Workspace creation

`POST /workspaces/create` has been ported to Express with JWT identity verification, UUID role-map validation against `directus_roles`, a PostgreSQL advisory transaction lock, workspace + owner-membership creation, active workspace selection, and a non-blocking audit insert. It reuses the original compiled artifact's validation and response-payload helpers. Unit tests cover the reused source rules.

**Not yet production-ready:** no live PostgreSQL integration test has been run; the new JWT issuer/secret contract has not been connected to the existing frontend or identity provider; the Directus schema and role UUID environment values still need verification. Do not point production traffic at this service yet.
