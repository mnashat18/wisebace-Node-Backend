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

export function createOrganizationRouter({db,authenticate}) {
  const router = express.Router();

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
