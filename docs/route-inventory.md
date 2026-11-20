# Directus extension route inventory

Source: the compiled Directus endpoint artifact uploaded in this conversation. The bundle is built around Directus runtime services and injected dependencies; it is not a standalone Node.js HTTP server.

| Method | Path | Status |
|---|---|---|
| POST | `/auth/email-availability` | Implemented; database integration verification pending |
| POST | `/avatar` | Pending |
| GET | `/files/:fileId` | Pending |
| POST | `/account-deletion-requests` | Pending |
| GET | `/organization` | Pending |
| PATCH | `/organization/profile` | Implemented; schema integration verification pending |
| POST | `/organization/departments` | Implemented; schema integration verification pending |
| PATCH | `/organization/departments/:departmentId` | Implemented; schema integration verification pending |
| POST | `/organization/departments/:departmentId/deactivate` | Implemented; schema integration verification pending |
| POST | `/scan-requests` | Pending |
| GET | `/scan-requests` | Pending |
| POST | `/alerts/:alertId/workflow` | Pending |
| GET | `/workforce` | Pending |
| POST | `/workspaces/invites` | Implemented for in-app invites; Directus email delivery pending |
| GET | `/workspaces/context` | Implemented; integration verification pending |
| GET | `/workspaces/invites/:inviteId` | Implemented; integration verification pending |
| POST | `/workspaces/invites/:inviteId/accept` | Implemented; integration verification pending |
| POST | `/workspaces/invites/:inviteId/decline` | Implemented; integration verification pending |
| POST | `/workspaces/switch` | Implemented; integration verification pending |
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

### In-app invitations

`POST /workspaces/invites` now validates the invite payload, restricts creation to Owner/HR in an active workspace, checks department ownership/activity, prevents duplicate memberships and conflicting pending invites, and creates the invitation, notification, and activity event transactionally for existing accounts. Unknown email addresses return an explicit 503 until the original Directus ItemsService/mail-flow integration is connected; no undelivered email invite is created. Live schema and notification-payload integration tests remain required.

`GET /workspaces/invites/:inviteId`, `POST /workspaces/invites/:inviteId/accept`, and `POST /workspaces/invites/:inviteId/decline` have been ported. They verify the signed-in account email against the invite, restrict access to in-app invitations, enforce expiry/status checks, create membership only after validating the department, update invite claim/decline state, and mark the linked notification read within the transaction. Integration tests against the actual Directus schema are still required.

### Workspace context and switching

`GET /workspaces/context` now resolves the user's eligible active memberships, selects the active workspace using the original role/date preference rules, and includes unexpired pending invitations for Owner/HR. `POST /workspaces/switch` validates that the requested membership belongs to the authenticated user, that the workspace and department remain active, and then updates the user's active workspace and Directus role. Both are transaction-locked. Live PostgreSQL and cross-tenant integration tests are still required.

### Workspace creation

`POST /workspaces/create` has been ported to Express with JWT identity verification, UUID role-map validation against `directus_roles`, a PostgreSQL advisory transaction lock, workspace + owner-membership creation, active workspace selection, and a non-blocking audit insert. It reuses the original compiled artifact's validation and response-payload helpers. Unit tests cover the reused source rules.

### Organization profile update

`PATCH /organization/profile` now enforces owner-only access to the authenticated user's active workspace, validates an allowlist of editable fields, normalizes website and team size, updates the profile and writes an activity event transactionally. The route returns the mapped organization profile shape. Database schema, authorization edge cases, and response parity still require integration tests.

`POST /organization/departments/:departmentId/deactivate` is also implemented. It is scoped to the authenticated user's active workspace, restricted to Owner/HR, refuses deactivation while active members remain assigned, and writes an activity event in the same transaction. Live schema and concurrency tests are still required.

`POST /organization/departments` and `PATCH /organization/departments/:departmentId` are implemented with Owner/HR authorization, active-workspace scoping, manager membership eligibility checks, transactional writes, and audit events. Department payload validators have unit tests. Live database, duplicate-name policy, and cross-tenant integration checks remain pending.\n\n**Migration count: 12 of 20 routes have at least a partial implementation; 8 routes remain pending.**

**Not yet production-ready:** no live PostgreSQL integration test has been run; the new JWT issuer/secret contract has not been connected to the existing frontend or identity provider; the Directus schema and role UUID environment values still need verification. Do not point production traffic at this service yet.
