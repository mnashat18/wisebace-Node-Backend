import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDepartmentCreate, parseDepartmentUpdate } from '../src/routes/organization.js';

const validMemberId = '550e8400-e29b-41d4-a716-446655440000';

test('department create accepts a normalized name and optional manager', () => {
  assert.deepEqual(parseDepartmentCreate({name:'  Operations   Team ',manager_member_id:validMemberId}), {
    payload:{name:'Operations Team',managerMemberId:validMemberId}
  });
});

test('department create rejects unknown fields and invalid manager ids', () => {
  assert.match(parseDepartmentCreate({name:'Operations',extra:true}).error,/unsupported/i);
  assert.match(parseDepartmentCreate({name:'Operations',manager_member_id:'not-a-uuid'}).error,/manager_member_id/);
});

test('department create rejects blank and oversized names', () => {
  assert.ok(parseDepartmentCreate({name:'   '}).error);
  assert.ok(parseDepartmentCreate({name:'x'.repeat(121)}).error);
});

test('department update supports changing only the manager or clearing it', () => {
  assert.deepEqual(parseDepartmentUpdate({manager_member_id:null}), {
    payload:{managerMemberId:null}
  });
});

test('department update rejects empty bodies and unsupported fields', () => {
  assert.match(parseDepartmentUpdate({}).error,/at least one/i);
  assert.match(parseDepartmentUpdate({is_active:false}).error,/unsupported/i);
});

test('department update validates names when supplied', () => {
  assert.deepEqual(parseDepartmentUpdate({name:'Safety'}),{payload:{name:'Safety'}});
  assert.ok(parseDepartmentUpdate({name:'  '}).error);
});
