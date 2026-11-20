import express from 'express';
import { randomUUID } from 'node:crypto';

const fail = (res,status,code,message) => res.status(status).json({error:{code,message}});
const editable = new Set(['company_name','contact_name','phone','industry','team_size','country','city','website','timezone','default_language']);
const placeholders = new Set(['test','testing','demo','sample','placeholder','example','lorem ipsum','dummy','temp','n/a','na','none','company name','your company','your name']);

function parseProfile(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return {error:'Request body must be a JSON object.'};
  const keys = Object.keys(body);
  if (!keys.length) return {error:'At least one editable organization field is required.'};
  if (keys.some(key => !editable.has(key))) return {error:'Request contains unsupported organization fields.'};
  const payload = {};
  for (const key of keys) {
    const value = body[key];
    if (key === 'team_size') {
      if (value == null || value === '') return {error:'team_size must be a positive integer.'};
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 100000)
        return {error:'team_size must be a positive integer.'};
      payload[key] = n;
      continue;
    }
    if (key === 'website') {
      if (value == null || value === '') { payload[key] = null; continue; }
      if (typeof value !== 'string') return {error:'website must be a valid URL.'};
      const raw = value.trim();
      try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://'+raw);
        const normalized = url.toString().replace(/\/$/,'');
        if (normalized.length > 255) return {error:'website is too long.'};
        payload[key] = normalized;
      } catch { return {error:'website must be a valid URL.'}; }
      continue;
    }
    if (value != null && typeof value !== 'string' && typeof value !== 'number')
      return {error:key+' must be a string.'};
    const text = value == null ? null : String(value).trim().replace(/\s+/g,' ');
    const max = ['company_name','contact_name'].includes(key) ? 120 : 255;
    if (text && text.length > max) return {error:key+' is too long.'};
    if (key === 'company_name' && (!text || text.length < 2 ||
        !/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}\s&'.,()\/-]*$/u.test(text) ||
        placeholders.has(text.toLowerCase())))
      return {error:'company_name is required and must be a real organization name.'};
    payload[key] = text || null;
  }
  if (!payload.company_name)
    return {error:'company_name is required.'};
  return {payload};
}


const roleName = value => {
  const role = String(value ?? '').trim().toLowerCase();
  if (role === 'admin') return 'hr';
  if (role === 'manger') return 'manager';
  if (role === 'member' || role === 'viewer') return 'employee';
  return role || null;
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const parseManagerId = value => {
  if (value == null || value === '') return {ok:true,value:null};
  if (typeof value !== 'string' || !uuidPattern.test(value.trim()))
    return {ok:false,message:'manager_member_id must be a valid membership id or null.'};
  return {ok:true,value:value.trim()};
};
const parseDepartmentName = value => {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\\s+/g,' ');
  if (!name || name.length > 120 || /[\\u0000-\\u001f\\u007f]/.test(name)) return null;
  return name;
};
export function parseDepartmentCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return {error:'Request body must be a JSON object.'};
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !['name','manager_member_id'].includes(key)))
    return {error:'Request contains unsupported department fields.'};
  const name = parseDepartmentName(body.name);
  if (!name) return {error:'Department name is required.'};
  const manager = parseManagerId(body.manager_member_id);
  if (!manager.ok) return {error:manager.message};
  return {payload:{name,managerMemberId:manager.value}};
}
export function parseDepartmentUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return {error:'Request body must be a JSON object.'};
  const keys = Object.keys(body);
  if (!keys.length) return {error:'At least one editable department field is required.'};
  if (keys.some(key => !['name','manager_member_id'].includes(key)))
    return {error:'Request contains unsupported department fields.'};
  const payload = {};
  if (Object.hasOwn(body,'name')) {
    const name = parseDepartmentName(body.name);
    if (!name) return {error:'Department name is required.'};
    payload.name = name;
  }
  if (Object.hasOwn(body,'manager_member_id')) {
    const manager = parseManagerId(body.manager_member_id);
    if (!manager.ok) return {error:manager.message};
    payload.managerMemberId = manager.value;
  }
  return {payload};
}

export function createOrganizationRouter({db,authenticate}) {
  const router = express.Router();


  router.post('/departments',authenticate,async (req,res) => {
    const parsed = parseDepartmentCreate(req.body ?? {});
    if (parsed.error) return fail(res,400,'BAD_REQUEST',parsed.error);
    const userId = req.auth.userId;
    try {
      const department = await db.transaction(async trx => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',
          [`wellar-organization-department-create:user:${userId}`]);
        const user = await trx('directus_users').select('active_business_profile')
          .where({id:userId}).first();
        if (!user?.active_business_profile) {
          const error = new Error('A verified active organization membership is required.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const membership = await trx('business_profile_members as member')
          .innerJoin('business_profiles as profile','profile.id','member.business_profile')
          .select('member.business_profile as workspace_id','member.member_role')
          .where('member.user',userId).andWhere('member.business_profile',user.active_business_profile)
          .andWhere('member.status','active').andWhere('profile.is_active',true).first();
        if (!membership) {
          const error = new Error('A verified active organization membership is required.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const role = roleName(membership.member_role);
        if (!['owner','hr'].includes(role)) {
          const error = new Error('Owner or HR access is required.');
          error.code = 'FORBIDDEN'; throw error;
        }
        let managerMemberId = null;
        if (parsed.payload.managerMemberId) {
          const manager = await trx('business_profile_members as member')
            .leftJoin('directus_users as user','user.id','member.user')
            .select('member.id','member.status','member.member_role','member.business_profile','user.id as user_id')
            .where('member.id',parsed.payload.managerMemberId).first();
          const managerRole = roleName(manager?.member_role);
          if (!manager || String(manager.business_profile) !== String(membership.workspace_id) ||
              manager.status !== 'active' || !manager.user_id ||
              !['owner','hr','manager'].includes(managerRole)) {
            const error = new Error('Selected manager is not eligible for this department.');
            error.code = 'BAD_REQUEST'; throw error;
          }
          managerMemberId = String(manager.id);
        }
        const id = randomUUID();
        const [created] = await trx('departments').insert({
          id,business_profile:membership.workspace_id,name:parsed.payload.name,
          is_active:true,manager_member:managerMemberId
        }).returning(['id','name','is_active','business_profile','manager_member','date_created','date_updated']);
        if (!created?.id) throw new Error('Department creation did not return an id.');
        await trx('activity_events').insert({
          id:randomUUID(),actor:userId,target_user:userId,
          action:'organization_department_created',entity_type:'department',
          entity_id:String(created.id),business_profile:membership.workspace_id,
          payload:JSON.stringify({source:'web_organization_admin',
            department_name:parsed.payload.name,manager_member_id:managerMemberId})
        });
        return {
          id:String(created.id),name:created.name??'Department',is_active:created.is_active===true,
          business_profile:String(created.business_profile),manager_member_id:created.manager_member??null,
          date_created:created.date_created??null,date_updated:created.date_updated??null
        };
      });
      return res.status(201).json({data:{department}});
    } catch(error) {
      if (error.code==='FORBIDDEN') return fail(res,403,'FORBIDDEN',error.message);
      if (error.code==='NOT_FOUND') return fail(res,404,'NOT_FOUND',error.message);
      if (error.code==='BAD_REQUEST') return fail(res,400,'BAD_REQUEST',error.message);
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] organization department creation failed');
      return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
    }
  });

  router.patch('/departments/:departmentId',authenticate,async (req,res) => {
    const departmentId = String(req.params.departmentId ?? '').trim();
    if (!departmentId) return fail(res,400,'BAD_REQUEST','departmentId is required.');
    const parsed = parseDepartmentUpdate(req.body ?? {});
    if (parsed.error) return fail(res,400,'BAD_REQUEST',parsed.error);
    const userId = req.auth.userId;
    try {
      const department = await db.transaction(async trx => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',
          [`wellar-organization-department-update:user:${userId}:${departmentId}`]);
        const user = await trx('directus_users').select('active_business_profile')
          .where({id:userId}).first();
        if (!user?.active_business_profile) {
          const error = new Error('A verified active organization membership is required.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const membership = await trx('business_profile_members as member')
          .innerJoin('business_profiles as profile','profile.id','member.business_profile')
          .select('member.business_profile as workspace_id','member.member_role')
          .where('member.user',userId).andWhere('member.business_profile',user.active_business_profile)
          .andWhere('member.status','active').andWhere('profile.is_active',true).first();
        if (!membership) {
          const error = new Error('A verified active organization membership is required.');
          error.code = 'NOT_FOUND'; throw error;
        }
        if (!['owner','hr'].includes(roleName(membership.member_role))) {
          const error = new Error('Owner or HR access is required.');
          error.code = 'FORBIDDEN'; throw error;
        }
        const current = await trx('departments').select(
          'id','name','is_active','business_profile','manager_member','date_created','date_updated'
        ).where({id:departmentId,business_profile:membership.workspace_id}).first();
        if (!current) {
          const error = new Error('The requested department was not found in the active organization.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const changes = {};
        if (Object.hasOwn(parsed.payload,'name')) changes.name = parsed.payload.name;
        if (Object.hasOwn(parsed.payload,'managerMemberId')) {
          const managerId = parsed.payload.managerMemberId;
          if (managerId) {
            const manager = await trx('business_profile_members as member')
              .leftJoin('directus_users as user','user.id','member.user')
              .select('member.id','member.status','member.member_role','member.business_profile','user.id as user_id')
              .where('member.id',managerId).first();
            if (!manager || String(manager.business_profile)!==String(membership.workspace_id) ||
                manager.status!=='active' || !manager.user_id ||
                !['owner','hr','manager'].includes(roleName(manager.member_role))) {
              const error = new Error('Selected manager is not eligible for this department.');
              error.code = 'BAD_REQUEST'; throw error;
            }
          }
          changes.manager_member = managerId;
        }
        await trx('departments').where({
          id:departmentId,business_profile:membership.workspace_id
        }).update(changes);
        const updated = await trx('departments').select(
          'id','name','is_active','business_profile','manager_member','date_created','date_updated'
        ).where({id:departmentId,business_profile:membership.workspace_id}).first();
        await trx('activity_events').insert({
          id:randomUUID(),actor:userId,target_user:userId,
          action:'organization_department_updated',entity_type:'department',
          entity_id:String(departmentId),business_profile:membership.workspace_id,
          payload:JSON.stringify({source:'web_organization_admin',
            changed_fields:Object.keys(changes).map(key=>key==='manager_member'?'manager_member':key)})
        });
        return {
          id:String(updated.id),name:updated.name??'Department',is_active:updated.is_active===true,
          business_profile:String(updated.business_profile),manager_member_id:updated.manager_member??null,
          date_created:updated.date_created??null,date_updated:updated.date_updated??null
        };
      });
      return res.status(200).json({data:{department}});
    } catch(error) {
      if (error.code==='FORBIDDEN') return fail(res,403,'FORBIDDEN',error.message);
      if (error.code==='NOT_FOUND') return fail(res,404,'NOT_FOUND',error.message);
      if (error.code==='BAD_REQUEST') return fail(res,400,'BAD_REQUEST',error.message);
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] organization department update failed');
      return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
    }
  });

  router.post('/departments/:departmentId/deactivate',authenticate,async (req,res) => {
    const departmentId = String(req.params.departmentId ?? '').trim();
    if (!departmentId) return fail(res,400,'BAD_REQUEST','departmentId is required.');
    const userId = req.auth.userId;
    try {
      const department = await db.transaction(async trx => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',
          [`wellar-organization-department-deactivate:user:${userId}:${departmentId}`]);
        const user = await trx('directus_users').select('active_business_profile')
          .where({id:userId}).first();
        if (!user?.active_business_profile) {
          const error = new Error('A verified active organization membership is required.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const membership = await trx('business_profile_members as member')
          .innerJoin('business_profiles as profile','profile.id','member.business_profile')
          .select('member.business_profile as workspace_id','member.member_role')
          .where('member.user',userId).andWhere('member.business_profile',user.active_business_profile)
          .andWhere('member.status','active').andWhere('profile.is_active',true).first();
        if (!membership) {
          const error = new Error('A verified active organization membership is required.');
          error.code = 'NOT_FOUND'; throw error;
        }
        if (!['owner','hr'].includes(String(membership.member_role).toLowerCase())) {
          const error = new Error('Owner or HR access is required.');
          error.code = 'FORBIDDEN'; throw error;
        }
        const current = await trx('departments').select(
          'id','name','is_active','business_profile','manager_member','date_created','date_updated'
        ).where({id:departmentId,business_profile:membership.workspace_id}).first();
        if (!current) {
          const error = new Error('The requested department was not found in the active organization.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const activeMembers = await trx('business_profile_members')
          .count('* as count').where({
            business_profile:membership.workspace_id,department:departmentId,status:'active'
          }).first();
        if (Number(activeMembers?.count ?? 0) > 0) {
          const error = new Error('Deactivate the department after reassigning its active members.');
          error.code = 'CONFLICT'; throw error;
        }
        await trx('departments').where({
          id:departmentId,business_profile:membership.workspace_id
        }).update({is_active:false});
        await trx('activity_events').insert({
          id:randomUUID(),actor:userId,target_user:userId,
          action:'organization_department_deactivated',entity_type:'department',
          entity_id:String(departmentId),business_profile:membership.workspace_id,
          payload:JSON.stringify({source:'web_organization_admin'})
        });
        const updated = await trx('departments').select(
          'id','name','is_active','business_profile','manager_member','date_created','date_updated'
        ).where({id:departmentId,business_profile:membership.workspace_id}).first();
        return {
          id:String(updated.id),name:updated.name??'Department',is_active:updated.is_active===true,
          business_profile:String(updated.business_profile),manager_member_id:updated.manager_member??null,
          date_created:updated.date_created??null,date_updated:updated.date_updated??null
        };
      });
      return res.status(200).json({data:{department}});
    } catch(error) {
      if (error.code==='FORBIDDEN') return fail(res,403,'FORBIDDEN',error.message);
      if (error.code==='NOT_FOUND') return fail(res,404,'NOT_FOUND',error.message);
      if (error.code==='CONFLICT') return fail(res,409,'CONFLICT',error.message);
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] organization department deactivation failed');
      return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
    }
  });

  router.patch('/profile',authenticate,async (req,res) => {
    const parsed = parseProfile(req.body ?? {});
    if (parsed.error) return fail(res,400,'BAD_REQUEST',parsed.error);
    const userId = req.auth.userId;
    try {
      const profile = await db.transaction(async trx => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',
          [`wellar-organization-profile:user:${userId}`]);
        const user = await trx('directus_users').select('active_business_profile').where({id:userId}).first();
        if (!user?.active_business_profile) {
          const error = new Error('A verified active organization membership is required.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const membership = await trx('business_profile_members as member')
          .innerJoin('business_profiles as profile','profile.id','member.business_profile')
          .select('member.business_profile as workspace_id','member.member_role','member.status',
            'profile.is_active').where('member.user',userId).andWhere('member.business_profile',user.active_business_profile)
          .andWhere('member.status','active').andWhere('profile.is_active',true).first();
        if (!membership) {
          const error = new Error('A verified active organization membership is required.');
          error.code = 'NOT_FOUND'; throw error;
        }
        if (String(membership.member_role).toLowerCase() !== 'owner') {
          const error = new Error('Only owners can edit the organization profile.');
          error.code = 'FORBIDDEN'; throw error;
        }
        const current = await trx('business_profiles').select(
          'id','company_name','contact_name','phone','industry','team_size','country','city',
          'website','timezone','default_language','is_active','plan_code','billing_status',
          'date_created','date_updated'
        ).where({id:membership.workspace_id}).first();
        if (!current) {
          const error = new Error('The active organization profile was not found.');
          error.code = 'NOT_FOUND'; throw error;
        }
        await trx('business_profiles').where({id:membership.workspace_id}).update(parsed.payload);
        await trx('activity_events').insert({
          actor:userId,target_user:userId,action:'organization_profile_updated',
          entity_type:'company',entity_id:String(membership.workspace_id),
          business_profile:membership.workspace_id,
          payload:JSON.stringify({source:'web_organization_admin',changed_fields:Object.keys(parsed.payload)})
        });
        const updated = await trx('business_profiles').select(
          'id','company_name','contact_name','phone','industry','team_size','country','city',
          'website','timezone','default_language','is_active','plan_code','billing_status',
          'date_created','date_updated'
        ).where({id:membership.workspace_id}).first();
        return {
          id:String(updated.id),company_name:updated.company_name??null,
          contact_name:updated.contact_name??null,phone:updated.phone??null,
          industry:updated.industry??null,team_size:updated.team_size??null,
          country:updated.country??null,city:updated.city??null,website:updated.website??null,
          timezone:updated.timezone??null,default_language:updated.default_language??null,
          is_active:updated.is_active===true,plan_code:updated.plan_code??null,
          billing_status:updated.billing_status??null,date_created:updated.date_created??null,
          date_updated:updated.date_updated??null
        };
      });
      return res.status(200).json({data:{profile}});
    } catch(error) {
      if (error.code==='FORBIDDEN') return fail(res,403,'FORBIDDEN',error.message);
      if (error.code==='NOT_FOUND') return fail(res,404,'NOT_FOUND',error.message);
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] organization profile update failed');
      return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
    }
  });
  return router;
}
