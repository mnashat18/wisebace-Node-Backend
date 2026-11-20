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
  routes.get('/context', authenticate, async (req,res) => {
    const userId = req.auth.userId;
    try {
      const data = await db.transaction(async trx => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',[`wellar-workspace-context:user:${userId}`]);
        const user = await trx('directus_users')
          .select('id','active_business_profile','active_department','active_member_role')
          .where({id:userId}).first();
        const memberships = await trx('business_profile_members as member')
          .innerJoin('business_profiles as profile','profile.id','member.business_profile')
          .leftJoin('departments as department','department.id','member.department')
          .select('member.id','member.user','member.status','member.member_role',
            'member.business_profile as workspace_id','member.department as department_id','member.joined_at',
            'profile.company_name','profile.is_active as workspace_is_active','profile.plan_code','profile.billing_status',
            'department.id as department_match_id','department.name as department_name',
            'department.business_profile as department_business_profile','department.is_active as department_is_active')
          .where('member.user',userId).andWhere('member.status','active').andWhere('profile.is_active',true);

        const normalizeRole = value => {
          const role = String(value ?? '').trim().toLowerCase();
          if (role === 'admin') return 'hr';
          if (role === 'manger') return 'manager';
          if (role === 'member' || role === 'viewer') return 'employee';
          return role || null;
        };
        const validMembership = row => {
          if (!row || String(row.status ?? '').toLowerCase() !== 'active' || row.workspace_is_active !== true) return false;
          if (row.department_id) {
            if (!row.department_match_id || String(row.department_business_profile) !== String(row.workspace_id) ||
                row.department_is_active === false) return false;
          }
          return true;
        };
        const priority = role => ({owner:4,hr:3,manager:2,employee:1}[normalizeRole(role)] || 0);
        const sortMemberships = rows => [...rows].sort((a,b) => {
          const roleDiff = priority(b.member_role) - priority(a.member_role);
          if (roleDiff) return roleDiff;
          const dateA = new Date(a.joined_at ?? 0).getTime();
          const dateB = new Date(b.joined_at ?? 0).getTime();
          if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) return dateB-dateA;
          return String(a.company_name ?? '').localeCompare(String(b.company_name ?? ''));
        });
        const eligible = memberships.filter(validMembership);
        const activeBusiness = String(user?.active_business_profile ?? '');
        const activeDepartment = String(user?.active_department ?? '');
        const activeRole = normalizeRole(user?.active_member_role);
        let active = null;
        if (eligible.length) {
          const sameWorkspace = activeBusiness
            ? eligible.filter(row => String(row.workspace_id) === activeBusiness)
            : [];
          if (!activeBusiness || !sameWorkspace.length) {
            active = sortMemberships(eligible)[0];
          } else {
            const exact = activeDepartment && activeRole
              ? sameWorkspace.filter(row => String(row.department_id ?? '') === activeDepartment &&
                  normalizeRole(row.member_role) === activeRole)
              : [];
            const departmentMatches = activeDepartment
              ? sameWorkspace.filter(row => String(row.department_id ?? '') === activeDepartment)
              : [];
            const roleMatches = activeRole
              ? sameWorkspace.filter(row => normalizeRole(row.member_role) === activeRole)
              : [];
            active = sortMemberships(exact.length ? exact :
              departmentMatches.length ? departmentMatches :
              roleMatches.length ? roleMatches : sameWorkspace)[0];
          }
        }
        const workspace = row => ({
          id:String(row.workspace_id ?? row.id ?? ''),
          companyName:row.company_name ?? 'Organization',
          isActive:row.workspace_is_active === true || row.is_active === true,
          planCode:row.plan_code ?? null,
          billingStatus:row.billing_status ?? null
        });
        const department = row => {
          const id = row.department_id ?? row.department;
          return id ? {id:String(id),name:row.department_name ?? 'Department'} : null;
        };
        const membership = row => ({
          id:String(row.id),status:row.status ?? 'active',memberRole:normalizeRole(row.member_role) ?? 'employee'
        });
        let invitations = [];
        if (active && ['owner','hr'].includes(normalizeRole(active.member_role))) {
          const rows = await trx('request_invites as invite')
            .leftJoin('departments as department','department.id','invite.department')
            .select('invite.id','invite.email','invite.member_role','invite.status','invite.invite_type',
              'invite.department as department_id','invite.expires_at','department.name as department_name')
            .where('invite.business_profile',active.workspace_id)
            .whereIn('invite.status',['pending','sent']).orderBy('invite.id','desc');
          const now = Date.now();
          invitations = rows.filter(row => {
            if (!row.expires_at) return true;
            const expires = new Date(row.expires_at).getTime();
            return !Number.isFinite(expires) || expires > now;
          }).map(row => ({
            id:String(row.id),email:row.email ?? 'Unavailable',
            memberRole:normalizeRole(row.member_role) ?? 'employee',
            status:row.status ?? 'pending',department:department(row),
            inviteType:String(row.invite_type ?? '').toLowerCase() || null
          }));
        }
        return {
          active:active ? {workspace:workspace(active),membership:membership(active),department:department(active)} : null,
          memberships:eligible.map(row => ({
            id:String(row.id),status:row.status ?? 'active',
            memberRole:normalizeRole(row.member_role) ?? 'employee',
            workspace:workspace(row),department:department(row)
          })),
          invitations
        };
      });
      return res.status(200).json({data});
    } catch (error) {
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] workspace context failed');
      return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
    }
  });

  routes.post('/switch', authenticate, async (req,res) => {
    const userId = req.auth.userId;
    const body = req.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return fail(res,400,'BAD_REQUEST','Request body must be a JSON object.');
    const membershipId = (typeof body.membership_id === 'string' || typeof body.membership_id === 'number') ? String(body.membership_id).trim() : '';
    if (!membershipId) return fail(res,400,'BAD_REQUEST','membership_id is required.');
    if (Object.keys(body).some(key => key !== 'membership_id'))
      return fail(res,400,'BAD_REQUEST','Only membership_id is accepted.');
    try {
      const selected = await db.transaction(async trx => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',[`wellar-workspace-switch:user:${userId}`]);
        const roles = getRoleIds(env);
        const roleRows = await trx('directus_roles').select('id').whereIn('id',Object.values(roles));
        if (roleRows.length !== 4) {
          const error = new Error('One or more Wellar role mappings do not match an existing Directus role.');
          error.code = 'CONFIGURATION_ERROR'; throw error;
        }
        const row = await trx('business_profile_members as member')
          .innerJoin('business_profiles as profile','profile.id','member.business_profile')
          .leftJoin('departments as department','department.id','member.department')
          .select('member.id','member.user','member.status','member.member_role',
            'member.business_profile as workspace_id','member.department as department_id','member.joined_at',
            'profile.company_name','profile.is_active as workspace_is_active','profile.plan_code','profile.billing_status',
            'department.id as department_match_id','department.name as department_name',
            'department.business_profile as department_business_profile','department.is_active as department_is_active')
          .where('member.id',membershipId).andWhere('member.user',userId).first();
        if (!row) {
          const error = new Error('The requested workspace membership was not found.');
          error.code = 'NOT_FOUND'; throw error;
        }
        if (String(row.status ?? '').toLowerCase() !== 'active') {
          const error = new Error('The requested workspace membership is not active.');
          error.code = 'CONFLICT'; throw error;
        }
        if (row.workspace_is_active !== true) {
          const error = new Error('The requested workspace is not active.');
          error.code = 'CONFLICT'; throw error;
        }
        if (row.department_id && (!row.department_match_id ||
            String(row.department_business_profile) !== String(row.workspace_id) ||
            row.department_is_active === false)) {
          const error = new Error('The membership department is no longer valid or active.');
          error.code = 'CONFLICT'; throw error;
        }
        const role = String(row.member_role ?? '').toLowerCase();
        const normalizedRole = role === 'admin' ? 'hr' : role === 'manger' ? 'manager' :
          ['member','viewer'].includes(role) ? 'employee' : role;
        if (!roles[normalizedRole]) {
          const error = new Error('The selected membership role is not configured.');
          error.code = 'CONFIGURATION_ERROR'; throw error;
        }
        await trx('directus_users').where({id:userId}).update({
          role:roles[normalizedRole],active_business_profile:row.workspace_id,
          active_department:row.department_id ?? null,active_member_role:normalizedRole
        });
        return {
          workspace:{id:String(row.workspace_id),companyName:row.company_name ?? 'Organization',
            isActive:row.workspace_is_active === true,planCode:row.plan_code ?? null,billingStatus:row.billing_status ?? null},
          membership:{id:String(row.id),status:row.status ?? 'active',memberRole:normalizedRole},
          department:row.department_id ? {id:String(row.department_id),name:row.department_name ?? 'Department'} : null
        };
      });
      return res.status(200).json({data:selected});
    } catch (error) {
      if (error.code === 'NOT_FOUND') return fail(res,404,'NOT_FOUND',error.message);
      if (error.code === 'CONFLICT') return fail(res,409,'CONFLICT',error.message);
      if (error.code === 'CONFIGURATION_ERROR') return fail(res,503,'CONFIGURATION_ERROR',error.message);
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] workspace switch failed');
      return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
    }
  });

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
