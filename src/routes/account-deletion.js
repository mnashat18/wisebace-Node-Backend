import express from 'express';
import { createHash } from 'node:crypto';

const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const acceptedMessage='Your account deletion request has been received. If the account information matches our records, the Wellar team will process the request and contact you if additional verification is required.';
const recentByEmail=new Map(),recentByIp=new Map();
const fail=(res,status,code,message)=>res.status(status).json({error:{code,message}});
function parse(body){
 if(!body||typeof body!=='object'||Array.isArray(body))return null;
 const keys=Object.keys(body);if(!keys.length||keys.some(k=>!['email','reason','confirmed'].includes(k)))return null;
 if(body.confirmed!==true||typeof body.email!=='string')return null;
 const email=body.email.trim().toLowerCase();
 if(!email||email.length>254||!EMAIL.test(email))return null;
 if(body.reason!==undefined&&body.reason!==null&&typeof body.reason!=='string')return null;
 const reason=typeof body.reason==='string'?body.reason.trim():null;
 if(reason&&reason.length>1000)return null;
 return {email,reason};
}
function clientIp(req){
 // Express req.ip is derived from the socket unless TRUST_PROXY is explicitly
 // configured. Never trust a client-supplied X-Forwarded-For header directly.
 return (typeof req.ip==='string'&&req.ip.trim())||req.socket?.remoteAddress||'unknown';
}
function cleanup(now){
 for(const [key,until] of recentByEmail)if(until<=now)recentByEmail.delete(key);
 for(const [key,times] of recentByIp){const fresh=times.filter(t=>t>now-3600000);if(fresh.length)recentByIp.set(key,fresh);else recentByIp.delete(key);}
 while(recentByEmail.size>2000)recentByEmail.delete(recentByEmail.keys().next().value);
 while(recentByIp.size>2000)recentByIp.delete(recentByIp.keys().next().value);
}
export function createAccountDeletionRouter({fetchImpl=fetch,env=process.env,now=Date.now}={}){
 const router=express.Router();
 router.post('/',async(req,res)=>{
  const payload=parse(req.body??{});if(!payload)return fail(res,400,'BAD_REQUEST','Invalid request.');
  const recipient=String(env.ACCOUNT_DELETION_RECIPIENT_EMAIL??'').trim();
  const base=String(env.DIRECTUS_URL??'').trim().replace(/\/$/,'');
  const token=String(env.DIRECTUS_STATIC_TOKEN??'').trim();
  if(!recipient||!EMAIL.test(recipient)||!base||!token){
   req.log?.error?.('[ACCOUNT_DELETION_REQUEST] accepted=false reason=mail_unavailable');
   return fail(res,503,'SERVICE_UNAVAILABLE','The service is temporarily unavailable. Please try again later.');
  }
  const timestamp=now(),ipHash=createHash('sha256').update(clientIp(req)).digest('hex');
  cleanup(timestamp);
  const emailHash=createHash('sha256').update(payload.email).digest('hex');
  const attempts=recentByIp.get(ipHash)??[];
  if((recentByEmail.get(emailHash)??0)>timestamp||attempts.filter(t=>t>timestamp-3600000).length>=5){
   req.log?.info?.('[ACCOUNT_DELETION_REQUEST] accepted=true duplicate_suppressed=true');
   return res.status(202).json({accepted:true,message:acceptedMessage});
  }
  const text=['Request type: account_deletion',`Normalized account email: ${payload.email}`,
   `Optional reason: ${payload.reason??'(not provided)'}`,`Requested timestamp (UTC): ${new Date(timestamp).toISOString()}`,
   'Staff must verify identity before deletion.'].join('\n');
  try{
   const response=await fetchImpl(base+'/utils/send-mail',{method:'POST',headers:{
    'Authorization':'Bearer '+token,'Content-Type':'application/json','Accept':'application/json'
   },body:JSON.stringify({to:recipient,subject:'Wellar account deletion request',text}),signal:AbortSignal.timeout(8000)});
   if(!response.ok)throw new Error('Directus mail service returned HTTP '+response.status);
   recentByEmail.set(emailHash,timestamp+900000);attempts.push(timestamp);recentByIp.set(ipHash,attempts.slice(-5));
   req.log?.info?.('[ACCOUNT_DELETION_REQUEST] accepted=true mail_sent=true');
   return res.status(202).json({accepted:true,message:acceptedMessage});
  }catch(error){
   req.log?.error?.({errorName:error.name},'[ACCOUNT_DELETION_REQUEST] mail delivery failed');
   return fail(res,503,'SERVICE_UNAVAILABLE','The service is temporarily unavailable. Please try again later.');
  }
 });
 return router;
}
export {parse as parseAccountDeletionRequest};
