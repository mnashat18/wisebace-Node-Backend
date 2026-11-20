import express from 'express';
import { randomUUID } from 'node:crypto';

const fail=(res,status,code,message)=>res.status(status).json({error:{code,message}});
const roleName=value=>({admin:'hr',manger:'manager',member:'employee',viewer:'employee'}[String(value??'').trim().toLowerCase()]??String(value??'').trim().toLowerCase());
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parseCreate(body){
 if(!body||typeof body!=='object'||Array.isArray(body))return {error:'Request body must be a JSON object.'};
 const keys=Object.keys(body),allowed=['target_member_id','request_type','due_at'];
 if(!keys.length)return {error:'target_member_id is required.'};
 if(keys.some(k=>!allowed.includes(k)))return {error:'Request contains unsupported scan request fields.'};
 const target=typeof body.target_member_id==='string'?body.target_member_id.trim():'';
 if(!uuid.test(target))return {error:'target_member_id is required.'};
 const type=typeof body.request_type==='string'?body.request_type.trim().toLowerCase():'manual';
 if(!['manual','bulk','reminder'].includes(type))return {error:'request_type must be manual, bulk, or reminder.'};
 const due=body.due_at==null||body.due_at===''?null:body.due_at;
 if(due!==null&&(typeof due!=='string'||!Number.isFinite(Date.parse(due))))return {error:'due_at must be a valid ISO timestamp.'};
 return {payload:{target,type,due}};
}
async function getActive(trx,userId){
 const user=await trx('directus_users').select('active_business_profile','active_department','active_member_role').where({id:userId}).first();
 if(!user?.active_business_profile)return null;
 const member=await trx('business_profile_members as m').innerJoin('business_profiles as p','p.id','m.business_profile')
 .leftJoin('departments as d','d.id','m.department')
 .select('m.id','m.member_role','m.status','m.business_profile as workspace_id','m.department as department_id',
 'p.company_name','d.id as department_match_id','d.business_profile as department_workspace','d.is_active as department_active')
 .where('m.user',userId).andWhere('m.business_profile',user.active_business_profile)
 .andWhere('m.status','active').andWhere('p.is_active',true).first();
 if(!member)return null;
 if(member.department_id&&(!member.department_match_id||String(member.department_workspace)!==String(member.workspace_id)||member.department_active===false))return null;
 return {...member,user};
}
function lifecycle(row){
 const status=String(row.status??'pending').toLowerCase(),due=row.due_at?new Date(row.due_at):null;
 if(status==='completed')return 'COMPLETED';if(status==='expired')return 'EXPIRED';
 if(['cancelled','canceled'].includes(status)||row.cancelled)return 'CANCELLED';if(status==='failed')return 'FAILED';
 return due&&Number.isFinite(due.getTime())&&due.getTime()<Date.now()?'OPEN_OVERDUE':'OPEN_PENDING';
}
async function loadRows(trx,workspaceId,filters={}){
 const rows=await trx('scan_requests as r').innerJoin('business_profiles as p','p.id','r.business_profile')
 .leftJoin('business_profile_members as m','m.id','r.target_member').leftJoin('directus_users as u','u.id','m.user')
 .leftJoin('departments as d','d.id','m.department').leftJoin('departments as rd','rd.id','r.department')
 .leftJoin('directus_users as actor','actor.id','r.requested_by_user')
 .select('r.id','r.business_profile','r.department','r.requested_by_user','r.target_member','r.status','r.request_type',
 'r.requested_at','r.due_at','r.completed_at','r.cancelled','p.company_name',
 'm.status as member_status','m.member_role','m.user as target_user_id','m.department as target_department_id',
 'u.email as target_email','u.first_name as target_first_name','u.last_name as target_last_name',
 'd.name as target_department_name','rd.name as request_department_name',
 'actor.id as actor_id','actor.email as actor_email','actor.first_name as actor_first_name','actor.last_name as actor_last_name')
 .where('r.business_profile',workspaceId).modify(q=>{
  if(filters.departmentId)q.andWhere('r.department',filters.departmentId);
  if(filters.memberId)q.andWhere('r.target_member',filters.memberId);
  if(filters.userId)q.andWhere(inner=>inner.where('r.requested_by_user',filters.userId).orWhere('m.user',filters.userId));
 }).orderBy('r.requested_at','desc').orderBy('r.id','desc');
 return rows.map(row=>{
  const deptId=row.target_department_id??row.department??null;
  const department=deptId?{id:String(deptId),name:row.target_department_name??row.request_department_name??'Department'}:null;
  const state=lifecycle(row),warnings=[];
  if(!row.target_member)warnings.push('missing_target_member');if(!row.requested_by_user)warnings.push('missing_requester');
  if(!row.department&&!deptId)warnings.push('missing_department');if(!row.business_profile)warnings.push('missing_workspace');
  return {id:String(row.id),status:row.status??'pending',lifecycle_status:state,relation_warnings:warnings,
   request_type:row.request_type??null,requested_at:row.requested_at??null,due_at:row.due_at??null,
   completed_at:row.completed_at??null,cancelled:row.cancelled??null,
   business_profile:{id:String(row.business_profile),companyName:row.company_name??'Organization',isActive:true,planCode:null,billingStatus:null},
   department,target_member:{id:String(row.target_member??''),status:row.member_status??'active',
    member_role:roleName(row.member_role)||'employee',user:row.target_user_id?{id:String(row.target_user_id),email:row.target_email??null,
     first_name:row.target_first_name??null,last_name:row.target_last_name??null}:null,department},
   requested_by_user:row.actor_id?{id:String(row.actor_id),email:row.actor_email??null,
    first_name:row.actor_first_name??null,last_name:row.actor_last_name??null}:{id:String(row.requested_by_user??'')}};
 });
}
function summary(rows){
 const s={totalRequests:0,openRequests:0,pending:0,overdue:0,completed:0,expired:0,cancelled:0,failed:0,dueToday:0,completionRate:0,total:0};
 const today=new Date();today.setHours(0,0,0,0);const tomorrow=new Date(today);tomorrow.setDate(tomorrow.getDate()+1);
 for(const row of rows){s.totalRequests++;const state=row.lifecycle_status;
  if(state==='COMPLETED')s.completed++;else if(state==='OPEN_OVERDUE'){s.openRequests++;s.overdue++;}
  else if(state==='OPEN_PENDING'){s.openRequests++;s.pending++;const due=row.due_at?new Date(row.due_at):null;if(due&&due>=today&&due<tomorrow)s.dueToday++;}
  else if(state==='EXPIRED')s.expired++;else if(state==='CANCELLED')s.cancelled++;else if(state==='FAILED')s.failed++;
 }
 s.total=s.totalRequests;s.completionRate=s.totalRequests?Math.round(s.completed/s.totalRequests*100):0;return s;
}
export function createScanRequestsRouter({db,authenticate}){
 const router=express.Router();
 router.post('/',authenticate,async(req,res)=>{
  const parsed=parseCreate(req.body??{});if(parsed.error)return fail(res,400,'BAD_REQUEST',parsed.error);
  const userId=req.auth.userId;
  try{
   const request=await db.transaction(async trx=>{
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))',['wellar-scan-request-create:user:'+userId+':'+parsed.payload.target]);
    const active=await getActive(trx,userId);
    if(!active){const e=new Error('A verified active organization membership is required.');e.code='NOT_FOUND';throw e;}
    if(!['owner','hr'].includes(roleName(active.member_role))){const e=new Error('Owner or HR access is required.');e.code='FORBIDDEN';throw e;}
    const target=await trx('business_profile_members as m').innerJoin('directus_users as u','u.id','m.user')
     .leftJoin('departments as d','d.id','m.department')
     .select('m.id','m.status','m.member_role','m.business_profile','m.department as department_id','u.id as user_id',
      'u.email','u.first_name','u.last_name','d.id as department_match_id','d.business_profile as department_workspace',
      'd.is_active as department_active','d.name as department_name')
     .where('m.id',parsed.payload.target).andWhere('m.business_profile',active.workspace_id).first();
    if(!target){const e=new Error('The requested workforce member was not found in the active organization.');e.code='NOT_FOUND';throw e;}
    if(!['hr','manager','employee'].includes(roleName(target.member_role))){const e=new Error('Scan requests can only target active HR, manager, or employee members.');e.code='CONFLICT';throw e;}
    if(String(target.status).toLowerCase()!=='active'||!target.user_id||!target.email){const e=new Error('The selected workforce member is not active or needs data repair.');e.code='CONFLICT';throw e;}
    if(target.department_id&&(!target.department_match_id||String(target.department_workspace)!==String(active.workspace_id)||target.department_active===false)){
     const e=new Error('The selected workforce member department is no longer valid.');e.code='CONFLICT';throw e;}
    const open=await trx('scan_requests').select('id').where({business_profile:active.workspace_id,target_member:target.id})
     .whereNotIn('status',['completed','expired','cancelled','canceled']).first();
    if(open){const e=new Error('An open scan request already exists for the selected member.');e.code='CONFLICT';throw e;}
    const [created]=await trx('scan_requests').insert({business_profile:active.workspace_id,department:target.department_id??null,
     requested_by_user:userId,target_member:target.id,request_type:parsed.payload.type,status:'pending',
     requested_at:trx.fn.now(),due_at:parsed.payload.due,completed_scan:null,completed_at:null,cancelled:null})
     .returning(['id','business_profile','department','requested_by_user','target_member','request_type','status','requested_at','due_at','completed_at','cancelled']);
    if(!created?.id)throw new Error('Scan request creation did not return an id.');
    const prior=await trx('notifications').select('id').where({business_profile:active.workspace_id,user:target.user_id,
     type:'scan_request',link_type:'scan_request',link_id:String(created.id)}).first();
    if(!prior?.id){const [notice]=await trx('notifications').insert({user:target.user_id,business_profile:active.workspace_id,
     title:'New scan request',body:'You have a new request to complete.',type:'scan_request',status:'unread',
     link_type:'scan_request',link_id:String(created.id),read_at:null,
     meta:JSON.stringify({type:'scan_request_created',screen:'scan_request_detail',scan_request_id:String(created.id)})}).returning(['id']);
     if(!notice?.id)throw new Error('Notification creation did not return an id.');}
    await trx('activity_events').insert({actor:userId,target_user:userId,action:'scan_request_created',
     entity_type:'scan_request',entity_id:String(created.id),business_profile:active.workspace_id,
     payload:JSON.stringify({source:'web_requests_page',target_member_id:String(target.id),request_type:parsed.payload.type,due_at:parsed.payload.due})});
    return {id:String(created.id),status:created.status??'pending',request_type:created.request_type,
     requested_at:created.requested_at,due_at:created.due_at,completed_at:created.completed_at,cancelled:created.cancelled,
     business_profile:{id:String(active.workspace_id),companyName:active.company_name??'Organization',isActive:true,planCode:null,billingStatus:null},
     department:target.department_id?{id:String(target.department_id),name:target.department_name??'Department'}:null,
     target_member:{id:String(target.id),status:target.status,member_role:roleName(target.member_role),
      user:{id:String(target.user_id),email:target.email,first_name:target.first_name??null,last_name:target.last_name??null},
      department:target.department_id?{id:String(target.department_id),name:target.department_name??'Department'}:null},
     requested_by_user:{id:String(userId),email:req.auth.email??null}};
   });
   return res.status(201).json({data:{request}});
  }catch(error){
   if(error.code==='FORBIDDEN')return fail(res,403,'FORBIDDEN',error.message);
   if(error.code==='NOT_FOUND')return fail(res,404,'NOT_FOUND',error.message);
   if(error.code==='CONFLICT')return fail(res,409,'CONFLICT',error.message);
   req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] scan request creation failed');
   return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
  }
 });
 router.get('/',authenticate,async(req,res)=>{
  const userId=req.auth.userId;
  try{
   const data=await db.transaction(async trx=>{
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))',['wellar-scan-requests:user:'+userId]);
    const active=await getActive(trx,userId);
    if(!active){const e=new Error('A verified active organization membership is required.');e.code='NOT_FOUND';throw e;}
    const role=roleName(active.member_role);
    if(!['owner','hr','manager','employee'].includes(role)){const e=new Error('A verified workspace role is required.');e.code='FORBIDDEN';throw e;}
    const filters={};
    if(role==='manager'){if(!active.department_id){const e=new Error('Manager account has no active department.');e.code='CONFLICT';throw e;}filters.departmentId=active.department_id;}
    else if(role==='employee'){filters.userId=userId;filters.memberId=String(active.id);}
    const rows=await loadRows(trx,active.workspace_id,filters);
    return {rows,summary:summary(rows)};
   });
   return res.status(200).json({data});
  }catch(error){
   if(error.code==='FORBIDDEN')return fail(res,403,'FORBIDDEN',error.message);
   if(error.code==='NOT_FOUND')return fail(res,404,'NOT_FOUND',error.message);
   if(error.code==='CONFLICT')return fail(res,409,'CONFLICT',error.message);
   req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] scan request queue failed');
   return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
  }
 });
 return router;
}
export {parseCreate as parseScanRequestCreate};
