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


import { SignJWT } from 'jose';
import { createAuthenticate } from '../src/middleware/authenticate.js';

const authSecret = 'test-only-secret-with-at-least-32-bytes';
const authUserId = '550e8400-e29b-41d4-a716-446655440000';
const authEnv = { AUTH_JWT_SECRET: authSecret, AUTH_JWT_ISSUER: 'wisepace-auth', AUTH_JWT_AUDIENCE: 'wisepace-api' };

async function makeToken(overrides = {}) {
 const now = Math.floor(Date.now() / 1000);
 return new SignJWT({ iat: now, exp: now + 3600, ...overrides })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer('wisepace-auth')
  .setAudience('wisepace-api')
  .setSubject(overrides.sub ?? authUserId)
  .sign(new TextEncoder().encode(authSecret));
}

function responseRecorder() {
 return {
  statusCode: 200,
  body: null,
  status(code) { this.statusCode=code; return this; },
  json(body) { this.body=body; return this; }
 };
}

function fakeDb(user, failure) {
 return () => ({
  select() { return this; },
  where() { return this; },
  async first() { if (failure) throw failure; return user; }
 });
}

test('authentication rejects requests without a bearer token',async()=>{
 const res=responseRecorder();
 let called=false;
 await createAuthenticate({db:fakeDb(null),env:authEnv})({headers:{}},res,()=>{called=true;});
 assert.equal(res.statusCode,401);
 assert.equal(called,false);
});

test('authentication rejects a validly signed token without expiry claims',async()=>{
 const token=await new SignJWT({iat:Math.floor(Date.now()/1000)})
  .setProtectedHeader({alg:'HS256'}).setIssuer('wisepace-auth').setAudience('wisepace-api')
  .setSubject(authUserId).sign(new TextEncoder().encode(authSecret));
 const res=responseRecorder();
 await createAuthenticate({db:fakeDb({id:authUserId,status:'active'}),env:authEnv})(
  {headers:{authorization:'Bearer '+token}},res,()=>{}
 );
 assert.equal(res.statusCode,401);
 assert.equal(res.body.error.message,'The access token lifetime is invalid.');
});

test('authentication accepts a valid short-lived token for an active Directus user',async()=>{
 const token=await makeToken();
 const res=responseRecorder();
 const req={headers:{authorization:'Bearer '+token}};
 let nextCalled=false;
 await createAuthenticate({db:fakeDb({id:authUserId,email:'person@example.com',status:'active'}),env:authEnv})(
  req,res,()=>{nextCalled=true;}
 );
 assert.equal(nextCalled,true);
 assert.equal(req.auth.userId,authUserId);
 assert.equal(req.auth.email,'person@example.com');
});

test('authentication rejects inactive users',async()=>{
 const token=await makeToken();
 const res=responseRecorder();
 await createAuthenticate({db:fakeDb({id:authUserId,status:'suspended'}),env:authEnv})(
  {headers:{authorization:'Bearer '+token}},res,()=>{}
 );
 assert.equal(res.statusCode,401);
});

test('authentication forwards database failures instead of disguising them as 401',async()=>{
 const token=await makeToken();
 const res=responseRecorder();
 const databaseError=new Error('database unavailable');
 let forwarded;
 await createAuthenticate({db:fakeDb(null,databaseError),env:authEnv})(
  {headers:{authorization:'Bearer '+token}},res,error=>{forwarded=error;}
 );
 assert.equal(forwarded,databaseError);
 assert.equal(res.statusCode,200);
});


test('Directus auth mode validates the bearer token against Directus /users/me',async()=>{
 const token='opaque-directus-access-token';
 let requested;
 const fetchImpl=async(url,options)=>{
  requested={url,authorization:options.headers.Authorization};
  return {ok:true,status:200,json:async()=>({data:{id:authUserId,email:'directus@example.com',status:'active'}})};
 };
 const res=responseRecorder(),req={headers:{authorization:'Bearer '+token}};
 let nextCalled=false;
 await createAuthenticate({db:fakeDb({id:authUserId,email:'local@example.com',status:'active'}),
  env:{AUTH_MODE:'directus',DIRECTUS_URL:'https://directus.example'},fetchImpl})(req,res,()=>{nextCalled=true;});
 assert.equal(nextCalled,true);
 assert.equal(requested.url,'https://directus.example/users/me?fields=id,email,status');
 assert.equal(requested.authorization,'Bearer '+token);
 assert.equal(req.auth.userId,authUserId);
 assert.equal(req.auth.email,'local@example.com');
 assert.equal(req.auth.provider,'directus');
});

test('Directus auth mode rejects tokens rejected by the identity provider',async()=>{
 const res=responseRecorder();
 await createAuthenticate({db:fakeDb({id:authUserId,status:'active'}),
  env:{AUTH_MODE:'directus',DIRECTUS_URL:'https://directus.example'},
  fetchImpl:async()=>({ok:false,status:401})})(
   {headers:{authorization:'Bearer invalid-token'}},res,()=>{}
  );
 assert.equal(res.statusCode,401);
});

test('Directus auth mode returns 503 when the identity provider is unavailable',async()=>{
 const res=responseRecorder();
 await createAuthenticate({db:fakeDb({id:authUserId,status:'active'}),
  env:{AUTH_MODE:'directus',DIRECTUS_URL:'https://directus.example'},
  fetchImpl:async()=>({ok:false,status:502})})(
   {headers:{authorization:'Bearer token'}},res,()=>{}
  );
 assert.equal(res.statusCode,503);
});

test('Directus auth mode refuses to trust a user absent from the local active-user table',async()=>{
 const res=responseRecorder();
 await createAuthenticate({db:fakeDb(null),
  env:{AUTH_MODE:'directus',DIRECTUS_URL:'https://directus.example'},
  fetchImpl:async()=>({ok:true,status:200,json:async()=>({data:{id:authUserId,email:'x@example.com'}})})})(
   {headers:{authorization:'Bearer valid-token'}},res,()=>{}
  );
 assert.equal(res.statusCode,401);
});
