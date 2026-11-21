import test from 'node:test';
import assert from 'node:assert/strict';
import knexFactory from 'knex';

const connection = process.env.WISPACE_TEST_DATABASE_URL;
const explicitlyAllowed = process.env.WISPACE_ALLOW_DB_TESTS === 'true';
const enabled = Boolean(connection && explicitlyAllowed);

const requiredSchema = {
  directus_users: ['id', 'email', 'status', 'active_business_profile'],
  directus_roles: ['id'],
  business_profiles: ['id', 'company_name', 'is_active'],
  business_profile_members: ['id', 'user', 'business_profile', 'department', 'member_role', 'status'],
  departments: ['id', 'name', 'business_profile', 'is_active'],
  request_invites: ['id', 'email', 'member_role', 'status', 'business_profile', 'department', 'invite_type', 'expires_at'],
  notifications: ['id', 'user', 'title', 'body', 'type', 'status', 'link_type', 'link_id'],
  activity_events: ['actor', 'target_user', 'action', 'entity_type', 'entity_id', 'business_profile', 'payload'],
  scan_requests: ['id', 'business_profile', 'department', 'requested_by_user', 'target_member', 'status', 'request_type', 'requested_at', 'due_at']
};

test('configured PostgreSQL schema satisfies the minimum migrated-route contract', {
  skip: !enabled && 'Set WISPACE_TEST_DATABASE_URL and WISPACE_ALLOW_DB_TESTS=true to run DB integration checks.'
}, async () => {
  const parsed = new URL(connection);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  assert.ok(databaseName && !/(^|[-_])(prod|production|live)([-_]|$)/.test(databaseName),
    'Refusing to run integration checks against a production-named database.');

  const db = knexFactory({ client: 'pg', connection, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 5000 });
  try {
    const [{ current_database: currentDatabase }] = await db.raw('select current_database()');
    assert.equal(currentDatabase, databaseName, 'Connected database does not match the configured test database.');

    const tables = Object.keys(requiredSchema);
    const columns = await db('information_schema.columns')
      .select('table_name', 'column_name')
      .where({ table_schema: 'public' })
      .whereIn('table_name', tables);
    const found = new Map();
    for (const row of columns) {
      if (!found.has(row.table_name)) found.set(row.table_name, new Set());
      found.get(row.table_name).add(row.column_name);
    }

    const missing = [];
    for (const [table, expectedColumns] of Object.entries(requiredSchema)) {
      const actual = found.get(table);
      if (!actual) {
        missing.push(`table public.${table}`);
        continue;
      }
      for (const column of expectedColumns) {
        if (!actual.has(column)) missing.push(`column public.${table}.${column}`);
      }
    }
    assert.deepEqual(missing, [], 'The configured database does not match the minimum route schema contract.');
  } finally {
    await db.destroy();
  }
});
