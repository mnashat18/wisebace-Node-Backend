import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompanyPayload, validateWorkspaceInvitePayload, validateMutationOrigin,
  parseSingleRange, resolveProtectedFileDelivery
} from '../reference/directus-extension.dist.js';

test('company onboarding payload rejects missing required fields', () => {
  const result = buildCompanyPayload({},'00000000-0000-4000-8000-000000000001',new Date(0).toISOString());
  assert.ok(result.error);
});
test('company onboarding payload normalizes email and applies free trial defaults', () => {
  const result = buildCompanyPayload({
    company_name:'Acme Inc',first_name:'Jane',last_name:'Doe',
    work_email:'JANE@ACME.COM',country:'Egypt'
  },'00000000-0000-4000-8000-000000000001',new Date(0).toISOString());
  assert.equal(result.value.work_email,'jane@acme.com');
  assert.equal(result.value.plan_code,'free');
  assert.equal(result.value.billing_status,'trialing');
});
test('invite validation allows employee and rejects owner self-assignment', () => {
  assert.equal(validateWorkspaceInvitePayload({email:'person@example.com',member_role:'owner'}).ok,false);
  assert.equal(validateWorkspaceInvitePayload({email:'person@example.com',member_role:'employee'}).ok,true);
});
test('origin policy rejects cross-origin cookie mutations', () => {
  assert.equal(validateMutationOrigin('POST','https://evil.example','session=abc'),false);
});
test('byte range parser rejects reversed ranges', () => {
  assert.deepEqual(parseSingleRange('bytes=10-20'),{start:10,end:20});
  assert.equal(parseSingleRange('bytes=20-10'),null);
});
test('protected file delivery only permits allowed media types', () => {
  assert.equal(resolveProtectedFileDelivery(['avatar'],'image/png').allowed,true);
  assert.equal(resolveProtectedFileDelivery(['avatar'],'text/html').allowed,false);
});

import { normalizeEmail } from '../src/lib/email.js';

test('email availability normalization trims and lowercases valid email', () => {
  assert.equal(normalizeEmail('  USER@Example.com '),'user@example.com');
  assert.equal(normalizeEmail('not-an-email'),null);
  assert.equal(normalizeEmail('x'.repeat(250)+'@a.com'),null);
});
