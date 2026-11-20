# Directus extension route inventory

Source: the compiled Directus endpoint artifact uploaded in this conversation. The bundle is built around Directus runtime services and injected dependencies; it is not a standalone Node.js HTTP server.

| Method | Path | Status |
|---|---|---|
| POST | `/auth/email-availability` | Pending |
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
| POST | `/workspaces/create` | Pending |

## Parity gates

- Authentication/session identity matches the current Directus accountability contract.
- Authorization and workspace/tenant isolation are enforced server-side.
- Input allowlists, validation, status codes and response envelopes match the current API.
- Multi-row mutations preserve PostgreSQL transactions, advisory locks, uniqueness/idempotency and rollback behavior.
- Audit events, email, push webhooks and file storage retain explicit failure semantics.
- Positive, negative, cross-tenant and concurrency tests pass before a route is marked migrated.

Do not point the production frontend at this service yet. Business routes remain deliberately unimplemented until their behavior is ported and verified.
