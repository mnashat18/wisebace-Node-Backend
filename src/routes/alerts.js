import express from 'express';

const fail=(res,status,code,message)=>res.status(status).json({error:{code,message}});
const roleName=value=>({admin:'hr',manger:'manager',member:'employee',viewer:'employee'}[String(value??'').trim().toLowerCase()]??String(value??'').trim().toLowerCase());
function parseAction(body){
 if(!body||typeof body!=='object'||Array.isArray(body))return null;
 const keys=Object.keys(body);if(keys.length!==1||keys[0]!=='action')return null;
 const action=typeof body.action==='string'?body.action.trim():'';
 return ['start_review','mark_reviewed','resolve'].includes(action)?action:null;
}
async function activeMembership(trx,userId,workspaceId){
 const user=await trx('directus_users').select('active_business_profile','active_department','active_member_role').where({id:userId}).first();
 if(!user?.active_business_profile)return null;
 if(workspaceId&&String(user.active_business_profile)!==String(workspaceId))return null;
 return trx('business_profile_members as m').innerJoin('business_profiles as p','p.id','m.business_profile')
  .select('m.id','m.member_role','m.status','m.business_profile as workspace_id','m.department as department_id',
   'p.is_active as workspace_active')
  .where('m.user',userId).andWhere('m.business_profile',user.active_business_profile)
  .andWhere('m.status','active').andWhere('p.is_active',true).first();
}
export function createAlertsRouter({db,authenticate}){
 const router=express.Router();
 router.post('/:alertId/workflow',authenticate,async(req,res)=>{
  const alertId=String(req.params.alertId??'').trim();if(!alertId)return fail(res,400,'BAD_REQUEST','alertId is required.');
  const action=parseAction(req.body??{});if(!action)return fail(res,400,'BAD_REQUEST','action must be start_review, mark_reviewed, or resolve.');
  const userId=req.auth.userId;
  try{
   const result=await db.transaction(async trx=>{
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))',['wellar-alert-workflow:alert:'+alertId]);
    const alert=await trx('alerts as a').leftJoin('departments as d','d.id','a.department')
     .select('a.id','a.business_profile','a.department','a.status','a.reviewed_by','a.reviewed_at',
      'a.action_note','a.action_type','a.date_created','a.date_updated','d.name as department_name')
     .where('a.id',alertId).forUpdate().first();
    if(!alert){const e=new Error('The requested alert was not found.');e.code='NOT_FOUND';throw e;}
    const membership=await activeMembership(trx,userId,alert.business_profile);
    if(!membership){const e=new Error('A verified active organization membership is required.');e.code='FORBIDDEN';throw e;}
    const role=roleName(membership.member_role);
    if(!['owner','hr','manager'].includes(role)){const e=new Error('Owner, HR, or manager access is required.');e.code='FORBIDDEN';throw e;}
    if(role==='manager'&&String(membership.department_id??'')!==String(alert.department??'')){
     const e=new Error('Manager workflow actions are limited to their own department.');e.code='FORBIDDEN';throw e;
    }
    const status=String(alert.status??'').toLowerCase();let changes;
    if(action==='start_review'&&status==='new')changes={status:'seen'};
    else if(action==='mark_reviewed'&&status==='seen')changes={status:'reviewed',reviewed_by:userId,reviewed_at:trx.fn.now()};
    else if(action==='resolve'&&status==='reviewed')changes={status:'resolved'};
    else{
     const e=new Error(['resolved','overridden'].includes(status)?
      'The selected alert workflow state can no longer be changed.':'The requested alert workflow transition is not valid.');
     e.code='CONFLICT';throw e;
    }
    const count=await trx('alerts').where({id:alertId,business_profile:alert.business_profile,status}).update(changes);
    if(count!==1){const e=new Error('The alert workflow state changed before the action could be applied.');e.code='CONFLICT';throw e;}
    const updated=await trx('alerts as a').leftJoin('directus_users as reviewer','reviewer.id','a.reviewed_by')
     .select('a.id','a.business_profile','a.department','a.status','a.reviewed_by','a.reviewed_at','a.action_note',
      'a.action_type','a.date_created','a.date_updated','reviewer.id as reviewer_id','reviewer.email as reviewer_email',
      'reviewer.first_name as reviewer_first_name','reviewer.last_name as reviewer_last_name')
     .where('a.id',alertId).first();
    if(!updated)throw new Error('Alert workflow update did not return a row.');
    return {alert:{id:String(updated.id),business_profile:updated.business_profile??null,
     department:updated.department??null,status:updated.status??null,
     reviewed_by:updated.reviewer_id?{id:String(updated.reviewer_id),email:updated.reviewer_email??null,
      first_name:updated.reviewer_first_name??null,last_name:updated.reviewer_last_name??null}:updated.reviewed_by??null,
     reviewed_at:updated.reviewed_at??null,action_note:updated.action_note??null,action_type:updated.action_type??null,
     date_created:updated.date_created??null,date_updated:updated.date_updated??null}};
   });
   return res.status(200).json({data:result});
  }catch(error){
   if(error.code==='FORBIDDEN')return fail(res,403,'FORBIDDEN',error.message);
   if(error.code==='NOT_FOUND')return fail(res,404,'NOT_FOUND',error.message);
   if(error.code==='CONFLICT')return fail(res,409,'CONFLICT',error.message);
   req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] alert workflow update failed');
   return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
  }
 });
 return router;
}
export {parseAction as parseAlertWorkflowAction};
