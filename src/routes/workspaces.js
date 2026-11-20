import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  buildBusinessProfileInsertPayload, buildCompanyPayload, buildCreatedWorkspaceResponse,
  buildOwnerMembershipInsertPayload, buildWorkspaceCreatedActivityEventPayload
} from '../../reference/directus-extension.dist.js';

const router = express.Router();
const forbiddenFields = new Set([
  'user','user_id','userId','requested_by_user','role','member_role','memberRole','owner',
  'is_owner','isOwner','business_profile','businessProfile','business_profile_id',
  'businessProfileId','workspace','workspace_id','workspaceId','membership','membership_id','membershipId'
]);
const roleEnv = {
  owner:'WELLAR_OWNER_ROLE_ID', hr:'WELLAR_HR_ROLE_ID',
  manager:'WELLAR_MANAGER_ROLE_ID', employee:'WELLAR_EMPLOYEE_ROLE_ID'
};
const fail = (res,status,code,message) => res.status(status).json({error:{code,message}});

function getRoleIds(env) {
  const ids = {};
  for (const [role,key] of Object.entries(roleEnv)) {
    const id = String(env[key] || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      const error = new Error(`${key} must be configured to an existing Directus role UUID.`);
      error.code = 'CONFIGURATION_ERROR'; throw error;
    }
    ids[role] = id;
  }
  if (new Set(Object.values(ids)).size !== 4) {
    const error = new Error('Wellar role mappings must point to unique Directus roles.');
    error.code = 'CONFIGURATION_ERROR'; throw error;
  }
  return ids;
}

export function createWorkspaceRouter({ db, env = process.env, authenticate }) {
  const routes = express.Router();
  routes.post('/create', authenticate, async (req,res) => {
    const userId = req.auth.userId;
    const body = req.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return fail(res,400,'BAD_REQUEST','Request body must be a JSON object.');
    if (Object.keys(body).some(key => forbiddenFields.has(key)))
      return fail(res,400,'BAD_REQUEST','Request contains forbidden ownership or workspace fields.');
    const idempotencyKey = String(body.idempotency_key ?? body.idempotencyKey ?? '').trim().slice(0,120);
    if (!idempotencyKey) return fail(res,400,'BAD_REQUEST','idempotency_key is required.');

    const company = buildCompanyPayload(body,userId,new Date().toISOString());
    if (company.error) return fail(res,400,'BAD_REQUEST',company.error);

    try {
      const result = await db.transaction(async trx => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',[`wellar-workspace-create:user:${userId}`]);
        const roles = getRoleIds(env);
        const roleRows = await trx('directus_roles').select('id').whereIn('id',Object.values(roles));
        if (roleRows.length !== 4) {
          const error = new Error('One or more Wellar role mappings do not match an existing Directus role.');
          error.code = 'CONFIGURATION_ERROR'; throw error;
        }
        const existing = await trx('business_profile_members as member')
          .leftJoin('business_profiles as profile','profile.id','member.business_profile')
          .select('member.id','member.business_profile','member.member_role','member.status',
            'profile.owner_user','profile.company_name','profile.is_active','profile.plan_code','profile.billing_status')
          .where('member.user',userId).first();
        if (existing) {
          if (String(existing.owner_user) === userId && existing.member_role === 'owner' &&
              existing.status === 'active' && existing.business_profile) {
            await trx('directus_users').where({id:userId}).update({
              role:roles.owner,active_business_profile:existing.business_profile,
              active_department:null,active_member_role:'owner'
            });
            const workspace = {
              id:existing.business_profile,company_name:existing.company_name,
              is_active:existing.is_active,plan_code:existing.plan_code,billing_status:existing.billing_status
            };
            return {status:200,data:buildCreatedWorkspaceResponse(workspace,existing)};
          }
          const error = new Error('This user already belongs to another workspace.');
          error.code = 'EXISTING_MEMBERSHIP'; throw error;
        }
        const oldOwner = await trx('business_profile_members').select('id')
          .where({user:userId,member_role:'owner'}).first();
        if (oldOwner) {
          const error = new Error('This user already has an owner membership.');
          error.code = 'EXISTING_OWNER_MEMBERSHIP'; throw error;
        }
        const ids = {businessProfileId:randomUUID(),activityEventId:randomUUID()};
        const [workspace] = await trx('business_profiles')
          .insert(buildBusinessProfileInsertPayload(company.value,ids))
          .returning(['id','company_name','is_active','plan_code','billing_status']);
        if (!workspace?.id) throw new Error('Workspace creation did not return an id.');
        const [membership] = await trx('business_profile_members')
          .insert(buildOwnerMembershipInsertPayload(userId,workspace.id,new Date().toISOString()))
          .returning(['id','business_profile','member_role','status']);
        if (!membership?.id) throw new Error('Owner membership creation did not return a membership id.');
        await trx('directus_users').where({id:userId}).update({
          role:roles.owner,active_business_profile:workspace.id,active_department:null,active_member_role:'owner'
        });
        return {
          status:201,data:buildCreatedWorkspaceResponse(workspace,membership),
          audit:{userId,businessProfileId:workspace.id,membershipId:membership.id,
            activityEventId:ids.activityEventId,idempotencyKey}
        };
      });
      if (result.audit) {
        try {
          await db('activity_events').insert(buildWorkspaceCreatedActivityEventPayload(result.audit));
        } catch (error) {
          req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] workspace audit insert failed');
        }
      }
      return res.status(result.status).json({data:result.data});
    } catch (error) {
      if (['EXISTING_MEMBERSHIP','EXISTING_OWNER_MEMBERSHIP'].includes(error.code))
        return fail(res,409,'CONFLICT',error.message);
      if (error.code === 'CONFIGURATION_ERROR')
        return fail(res,503,'CONFIGURATION_ERROR',error.message);
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] workspace creation failed');
      return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
    }
  });
  return routes;
}
