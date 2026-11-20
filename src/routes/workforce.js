import express from 'express';

const fail=(res,status,code,message)=>res.status(status).json({error:{code,message}});
const roleName=value=>({admin:'hr',manger:'manager',member:'employee',viewer:'employee'}[String(value??'').trim().toLowerCase()]??String(value??'').trim().toLowerCase());
const fullName=(first,last)=>[first,last].filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim()).join(' ');
function memberRow(row,canViewEmail){
 const role=roleName(row.member_role)||'employee',status=String(row.status??'active').trim().toLowerCase();
 const userId=row.user_id?String(row.user_id):null,email=row.user_email??null;
 const state=status!=='active'?'inactive':userId&&email?'verified_member':'repair_required';
 const display=state==='repair_required'?'Data repair required':fullName(row.first_name,row.last_name)|| (canViewEmail?email:null)||'Needs data repair';
 return {id:String(row.id),type:'member',state,category:state==='inactive'?'INACTIVE_MEMBER':state==='repair_required'?'NEEDS_ATTENTION':'ACTIVE_MEMBER',
  member_id:String(row.id),invite_id:null,user_id:userId,member_role:role,status,
  department_id:row.department_id?String(row.department_id):null,department_name:row.department_name??null,
  display_name:display,email:canViewEmail?email:null,invited_email:null,
  reason:state==='repair_required'?(userId?'missing email':'missing linked user'):null,
  is_targetable:state==='verified_member'&&['hr','manager','employee'].includes(role)&&Boolean(canViewEmail&&email),
  joined_at:row.joined_at??null,expires_at:null,last_scan_at:null,last_readiness_score:null,last_risk_level:null,
  scan_status:null,todays_scan:false,readiness_label:null,presence_status:null,presence_label:null};
}
function inviteRow(row,canViewEmail){
 const email=canViewEmail?row.email??null:null;
 return {id:String(row.id),type:'invite',state:'pending_invitation',category:'PENDING_INVITATION',
  member_id:null,invite_id:String(row.id),user_id:null,member_role:roleName(row.member_role)||'employee',
  status:row.status??'pending',department_id:row.department_id?String(row.department_id):null,
  department_name:row.department_name??null,display_name:'Invitation pending',email,invited_email:email,
  reason:email?null:'invitation email unavailable',is_targetable:false,joined_at:null,expires_at:row.expires_at??null,
  last_scan_at:null,last_readiness_score:null,last_risk_level:null,scan_status:'not_applicable',todays_scan:false,
  readiness_label:'No scan',presence_status:'never',presence_label:'Never active'};
}
async function activeContext(trx,userId){
 const user=await trx('directus_users').select('active_business_profile','active_department','active_member_role').where({id:userId}).first();
 if(!user?.active_business_profile)return null;
 const m=await trx('business_profile_members as m').innerJoin('business_profiles as p','p.id','m.business_profile')
 .leftJoin('departments as d','d.id','m.department')
 .select('m.id','m.status','m.member_role','m.business_profile as workspace_id','m.department as department_id',
  'p.company_name','p.is_active as workspace_is_active','p.plan_code','p.billing_status',
  'd.id as department_match_id','d.name as department_name','d.business_profile as department_workspace','d.is_active as department_active')
 .where('m.user',userId).andWhere('m.business_profile',user.active_business_profile).andWhere('m.status','active')
 .andWhere('p.is_active',true).first();
 if(!m)return null;
 if(m.department_id&&(!m.department_match_id||String(m.department_workspace)!==String(m.workspace_id)||m.department_active===false))return null;
 return {...m,user};
}
async function scanSummary(trx,workspaceId,filters){
 const q=trx('scan_requests as r').select('r.id','r.status','r.due_at','r.completed_at','r.target_member')
 .where('r.business_profile',workspaceId).modify(builder=>{
  if(filters.departmentId)builder.andWhere('r.department',filters.departmentId);
  if(filters.userId)builder.andWhere('r.requested_by_user',filters.userId);
 });
 const rows=await q;const today=new Date();today.setHours(0,0,0,0);const tomorrow=new Date(today);tomorrow.setDate(tomorrow.getDate()+1);
 const s={totalRequests:0,openRequests:0,pending:0,overdue:0,completed:0,expired:0,cancelled:0,failed:0,dueToday:0,completionRate:0,total:0};
 for(const r of rows){s.totalRequests++;const status=String(r.status??'pending').toLowerCase(),due=r.due_at?new Date(r.due_at):null;
  if(status==='completed')s.completed++;else if(status==='expired')s.expired++;else if(['cancelled','canceled'].includes(status))s.cancelled++;
  else if(status==='failed')s.failed++;else if(due&&due<new Date()){s.openRequests++;s.overdue++;}
  else{s.openRequests++;s.pending++;if(due&&due>=today&&due<tomorrow)s.dueToday++;}
 }
 s.total=s.totalRequests;s.completionRate=s.totalRequests?Math.round(s.completed/s.totalRequests*100):0;return s;
}
export function createWorkforceRouter({db,authenticate}){
 const router=express.Router();
 router.get('/',authenticate,async(req,res)=>{
  const userId=req.auth.userId;
  try{
   const data=await db.transaction(async trx=>{
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))',['wellar-workforce-roster:user:'+userId]);
    const active=await activeContext(trx,userId);
    if(!active){const e=new Error('A verified active organization membership is required.');e.code='NOT_FOUND';throw e;}
    const role=roleName(active.member_role);
    if(!['owner','hr','manager'].includes(role)){const e=new Error('Owner, HR, or manager access is required.');e.code='FORBIDDEN';throw e;}
    const canViewEmail=role==='owner'||role==='hr';
    const [memberRows,inviteRows,departments,scanRequests]=await Promise.all([
     trx('business_profile_members as m').leftJoin('departments as d','d.id','m.department')
      .leftJoin('directus_users as u','u.id','m.user')
      .select('m.id','m.status','m.member_role','m.user as user_id','m.business_profile','m.department as department_id',
       'm.joined_at','m.date_created','m.date_updated','d.name as department_name',
       'u.first_name','u.last_name','u.email as user_email')
      .where('m.business_profile',active.workspace_id).orderBy('m.id','desc'),
     canViewEmail?trx('request_invites as i').leftJoin('departments as d','d.id','i.department')
      .select('i.id','i.email','i.member_role','i.status','i.invite_type','i.department as department_id',
       'i.expires_at','d.name as department_name').where('i.business_profile',active.workspace_id)
      .whereIn('i.status',['pending','sent']).orderBy('i.id','desc'):Promise.resolve([]),
     trx('departments').select('id','name','is_active').where({business_profile:active.workspace_id}).orderBy('name','asc'),
     scanSummary(trx,active.workspace_id,role==='manager'?{departmentId:active.department_id}: {})
    ]);
    let rows=memberRows.map(row=>memberRow(row,canViewEmail));
    const invitations=inviteRows.map(row=>inviteRow(row,canViewEmail));
    rows=role==='manager'?rows.filter(row=>row.department_id&&row.department_id===String(active.department_id)):[...invitations,...rows];
    const eligible=rows.filter(row=>row.state==='verified_member'&&['hr','manager','employee'].includes(row.member_role)&&Boolean(row.email))
     .map(row=>({member_id:row.member_id,user_id:row.user_id,label:row.display_name,email:row.email,
      department_id:row.department_id,department_name:row.department_name,member_role:row.member_role,status:row.status}));
    const activeMembers=rows.filter(row=>row.category==='ACTIVE_MEMBER').length;
    const pendingInvitations=rows.filter(row=>row.category==='PENDING_INVITATION').length;
    const inactiveMembers=rows.filter(row=>row.category==='INACTIVE_MEMBER').length;
    const needsAttention=rows.filter(row=>row.category==='NEEDS_ATTENTION').length;
    const summary={activeMembers,pendingInvitations,inactiveMembers,needsAttention,eligibleMembers:eligible.length,
     completedToday:0,participationRate:0,totalRecords:rows.length,departments:departments.filter(d=>d.is_active===true).length,
     scanRequested:scanRequests.pending+scanRequests.overdue,missingScans:eligible.length,
     ownerCount:rows.filter(row=>row.member_role==='owner'&&row.category==='ACTIVE_MEMBER').length,
     hrCount:rows.filter(row=>row.member_role==='hr'&&row.category==='ACTIVE_MEMBER').length,
     managerCount:rows.filter(row=>row.member_role==='manager'&&row.category==='ACTIVE_MEMBER').length,
     employeeCount:rows.filter(row=>row.member_role==='employee'&&row.category==='ACTIVE_MEMBER').length,
     total:rows.length,verified_members:activeMembers,pending_invitations:pendingInvitations,
     repair_required:needsAttention,inactive:inactiveMembers,eligible_scan_targets:eligible.length,
     open_scan_requests:scanRequests.pending+scanRequests.overdue,completed_scan_requests:scanRequests.completed,
     overdue_scan_requests:scanRequests.overdue};
    return {workspace:{id:String(active.workspace_id),companyName:active.company_name??'Organization',
      isActive:true,planCode:active.plan_code??null,billingStatus:active.billing_status??null},
     permissions:{canEditProfile:role==='owner',canManageDepartments:canViewEmail,
      canViewMembers:canViewEmail,canViewInvites:canViewEmail,canUseComingSoonControls:false},
     departments:departments.map(d=>({id:String(d.id),name:d.name??'Department',is_active:d.is_active===true})),
     rows,eligible_scan_targets:eligible,scan_requests:{rows:[],summary:scanRequests},summary,
     active:{workspace:{id:String(active.workspace_id),companyName:active.company_name??'Organization',isActive:true,
       planCode:active.plan_code??null,billingStatus:active.billing_status??null},
      membership:{id:String(active.id),status:active.status??'active',memberRole:role},
      department:active.department_id?{id:String(active.department_id),name:active.department_name??'Department'}:null}};
   });
   return res.status(200).json({data});
  }catch(error){
   if(error.code==='FORBIDDEN')return fail(res,403,'FORBIDDEN',error.message);
   if(error.code==='NOT_FOUND')return fail(res,404,'NOT_FOUND',error.message);
   req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] workforce roster failed');
   return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
  }
 });
 return router;
}
