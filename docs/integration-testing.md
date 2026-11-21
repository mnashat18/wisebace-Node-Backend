# PostgreSQL integration checks

The default unit-test suite does not need database credentials. A separate schema contract test is included and is skipped unless both variables below are explicitly supplied:

```bash
WISPACE_TEST_DATABASE_URL=postgresql://.../wisepace_test
WISPACE_ALLOW_DB_TESTS=true
npm run test:integration
```

Use a disposable test database populated from the same Directus schema/migrations as the target environment. The check refuses database names containing a standalone `prod`, `production`, or `live` segment. This is a guardrail, not a substitute for using isolated credentials and infrastructure.

The current contract checks the minimum set of public tables and columns referenced by the migrated workspace, organization, invitation, scan-request, workforce, and authentication flows. Passing this check does **not** prove row-level tenant isolation, response parity, transaction behavior, external mail delivery, file streaming, or frontend compatibility. Those require seeded integration tests and an actual staging environment.

Never paste production credentials into source control or CI logs. Configure secrets in the deployment/CI secret store and use a dedicated non-production database.
