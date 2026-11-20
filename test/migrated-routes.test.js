import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScanRequestCreate} from '../src/routes/scan-requests.js';
import {parseAlertWorkflowAction} from '../src/routes/alerts.js';
import {parseAccountDeletionRequest} from '../src/routes/account-deletion.js';

const memberId='550e8400-e29b-41d4-a716-446655440000';

test('scan request accepts a valid member and default request type',()=>{
 const result=parseScanRequestCreate({target_member_id:memberId});
 assert.deepEqual(result,{payload:{target:memberId,type:'manual',due:null}});
});

test('scan request rejects unknown fields and invalid request types',()=>{
 assert.match(parseScanRequestCreate({target_member_id:memberId,workspace_id:'spoofed'}).error,/unsupported/i);
 assert.match(parseScanRequestCreate({target_member_id:memberId,request_type:'unknown'}).error,/request_type/i);
});

test('alert workflow only accepts the supported transitions',()=>{
 assert.equal(parseAlertWorkflowAction({action:'start_review'}),'start_review');
 assert.equal(parseAlertWorkflowAction({action:'resolve'}),'resolve');
 assert.equal(parseAlertWorkflowAction({action:'delete'}),null);
 assert.equal(parseAlertWorkflowAction({action:'resolve',status:'new'}),null);
});

test('account deletion request requires explicit confirmation and valid email',()=>{
 assert.deepEqual(parseAccountDeletionRequest({confirmed:true,email:' Person@Example.com ',reason:'Please contact me'}),{
  email:'person@example.com',reason:'Please contact me'
 });
 assert.equal(parseAccountDeletionRequest({confirmed:false,email:'person@example.com'}),null);
 assert.equal(parseAccountDeletionRequest({confirmed:true,email:'not-an-email'}),null);
 assert.equal(parseAccountDeletionRequest({confirmed:true,email:'person@example.com',extra:true}),null);
});
