import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  buildBusinessProfileInsertPayload, buildCompanyPayload, buildCreatedWorkspaceResponse,
  buildOwnerMembershipInsertPayload, buildWorkspaceCreatedActivityEventPayload,
  validateWorkspaceInvitePayload
} from '../../reference/directus-extension.dist.js';

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

  routes.post('/invites', authenticate, async (req,res) => {
    const parsed = validateWorkspaceInvitePayload(req.body ?? {});
    if (!parsed.ok) return fail(res,400,'BAD_REQUEST',parsed.message);
    const userId = req.auth.userId;
    try {
      const result = await db.transaction(async trx => {
        const active = await trx('business_profile_members as member')
          .innerJoin('business_profiles as profile','profile.id','member.business_profile')
          .select('member.id','member.member_role','member.status',
            'member.business_profile as workspace_id','profile.company_name','profile.is_active')
          .where('member.user',userId).andWhere('member.status','active')
          .andWhere('profile.is_active',true).first();
        if (!active) {
          const error = new Error('A verified active organization membership is required.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const actorRole = roleName(active.member_role);
        if (!['owner','hr'].includes(actorRole)) {
          const error = new Error('Owner or HR access is required.');
          error.code = 'FORBIDDEN'; throw error;
        }
        const email = String(parsed.payload.email).trim().toLowerCase();
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',
          [`wellar-workspace-invite:${active.workspace_id}:${email}`]);
        const existingUser = await trx('directus_users').select('id','email')
          .whereRaw('LOWER(TRIM(email)) = ?',[email]).first();
        if (existingUser?.id) {
          const existingMember = await trx('business_profile_members').select('id','status')
            .where({user:existingUser.id,business_profile:active.workspace_id})
            .whereIn('status',['active','invited']).first();
          if (existingMember?.id) {
            const error = new Error('This person is already an active member of the organization.');
            error.code = 'CONFLICT'; throw error;
          }
        }
        if (parsed.payload.department) {
          const department = await trx('departments').select('id','name','is_active','business_profile')
            .where({id:parsed.payload.department,business_profile:active.workspace_id}).first();
          if (!department?.id || department.is_active === false) {
            const error = new Error('The selected department does not belong to the active organization or is inactive.');
            error.code = 'NOT_FOUND'; throw error;
          }
        }
        const pending = existingUser?.id ? await trx('request_invites as invite')
          .leftJoin('departments as department','department.id','invite.department')
          .select('invite.id','invite.email','invite.member_role','invite.status','invite.business_profile',
            'invite.department','invite.invite_type','invite.expires_at','invite.requested_by_user',
            'department.name as department_name')
          .where('invite.business_profile',active.workspace_id)
          .whereRaw('LOWER(TRIM(invite.email)) = ?',[email])
          .whereIn('invite.status',['pending','sent']).orderBy('invite.id','desc').first() : null;
        if (pending && (!pending.expires_at ||
            !Number.isFinite(new Date(pending.expires_at).getTime()) ||
            new Date(pending.expires_at).getTime() > Date.now())) {
          const same = String(pending.email).trim().toLowerCase() === email &&
            roleName(pending.member_role) === parsed.payload.member_role &&
            String(pending.department ?? '') === String(parsed.payload.department ?? '');
          if (!same) {
            const error = new Error('A pending invitation already exists for this email address.');
            error.code = 'CONFLICT'; throw error;
          }
          const notification = await trx('notifications').select('id')
            .where({user:existingUser.id,link_type:'invite',link_id:String(pending.id)}).first();
          return {status:200,data:{
            ok:true,message:'Invitation sent in Wellar.',inviteId:String(pending.id),
            deliveryChannel:'in_app',...(notification?.id ? {notificationId:String(notification.id)} : {}),
            invite:{id:String(pending.id),email:pending.email,
              memberRole:roleName(pending.member_role) ?? 'employee',status:pending.status ?? 'pending',
              department:pending.department ? {id:String(pending.department),name:pending.department_name ?? 'Department'} : null,
              inviteType:'in_app'}
          }};
        }
        // Unknown email addresses require the original Directus ItemsService + email flow.
        // Do not create an email-type invite unless a real delivery provider is wired in.
        if (!existingUser?.id) {
          const error = new Error('Email invitations require the Directus invitation service and configured mail flow.');
          error.code = 'EMAIL_DELIVERY_NOT_CONFIGURED'; throw error;
        }
        const expiresAt = new Date(Date.now()+7*24*60*60*1000).toISOString();
        const [invite] = await trx('request_invites').insert({
          email,member_role:parsed.payload.member_role,business_profile:active.workspace_id,
          requested_by_user:userId,invite_type:'in_app',status:'pending',
          department:parsed.payload.department ?? null,sent_at:null,claimed_at:null,
          expires_at:expiresAt,accepted_user:null
        }).returning(['id','email','member_role','status','business_profile','department',
          'invite_type','expires_at','requested_by_user']);
        if (!invite?.id) throw new Error('Invitation creation did not return an id.');
        const [existingNotification] = await trx('notifications').select('id')
          .where({user:existingUser.id,link_type:'invite',link_id:String(invite.id)}).limit(1);
        let notificationId = existingNotification?.id ?? null;
        if (!notificationId) {
          const meta = JSON.stringify({
            type:'workspace_invitation',screen:'invite_detail',invite_id:String(invite.id),
            invite_type:'in_app',business_profile_id:String(active.workspace_id),
            department_id:parsed.payload.department ?? null,requested_by_user:userId,notification_id:null
          });
          const [notification] = await trx('notifications').insert({
            user:existingUser.id,business_profile:null,
            title:`${active.company_name || 'Workspace'} invitation`,
            body:`You have been invited to join ${active.company_name || 'this organization'} as ${parsed.payload.member_role === 'hr' ? 'HR' : parsed.payload.member_role === 'manager' ? 'Manager' : 'Employee'}.`,
            type:'invite',status:'unread',link_type:'invite',link_id:String(invite.id),
            read_at:null,meta
          }).returning(['id']);
          if (!notification?.id) throw new Error('Invite notification creation did not return an id.');
          notificationId = notification.id;
          await trx('notifications').where({id:notificationId}).update({
            meta:JSON.stringify({
              type:'workspace_invitation',screen:'invite_detail',invite_id:String(invite.id),
              invite_type:'in_app',business_profile_id:String(active.workspace_id),
              department_id:parsed.payload.department ?? null,requested_by_user:userId,
              notification_id:String(notificationId)
            })
          });
        }
        await trx('activity_events').insert({
          actor:userId,target_user:userId,action:'organization_invite_created',
          entity_type:'request_invite',entity_id:String(invite.id),
          business_profile:active.workspace_id,
          payload:JSON.stringify({source:'web_workspace_invites',email:invite.email ?? null,
            member_role:invite.member_role ?? null,department_id:parsed.payload.department ?? null,
            invite_type:'in_app'})
        });
        const department = parsed.payload.department ? await trx('departments')
          .select('id','name').where({id:parsed.payload.department}).first() : null;
        return {status:201,data:{
          ok:true,message:'Invitation sent in Wellar.',inviteId:String(invite.id),
          deliveryChannel:'in_app',notificationId:String(notificationId),
          invite:{id:String(invite.id),email:invite.email,
            memberRole:roleName(invite.member_role) ?? 'employee',status:invite.status ?? 'pending',
            department:department ? {id:String(department.id),name:department.name ?? 'Department'} : null,
            inviteType:'in_app'}
        }};
      });
      return res.status(result.status).json({data:result.data});
    } catch (error) {
      if (error.code === 'FORBIDDEN') return fail(res,403,'FORBIDDEN',error.message);
      if (error.code === 'NOT_FOUND') return fail(res,404,'NOT_FOUND',error.message);
      if (error.code === 'CONFLICT') return fail(res,409,'CONFLICT',error.message);
      if (error.code === 'EMAIL_DELIVERY_NOT_CONFIGURED')
        return fail(res,503,'EMAIL_DELIVERY_NOT_CONFIGURED',error.message);
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] invite creation failed');
      return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
    }
  });

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

  const roleName = value => {
    const role = String(value ?? '').trim().toLowerCase();
    if (role === 'admin') return 'hr';
    if (role === 'manger') return 'manager';
    if (role === 'member' || role === 'viewer') return 'employee';
    return role || null;
  };
  const invitationDetail = (row, canAct) => {
    const departmentId = row.department_id ?? row.department ?? null;
    const requestedById = row.requested_by_user_id ?? row.requested_by_user ?? null;
    const requestedByEmail = row.requested_by_user_email ?? null;
    const first = String(row.requested_by_user_first_name ?? '').trim();
    const last = String(row.requested_by_user_last_name ?? '').trim();
    const displayName = [first,last].filter(Boolean).join(' ') || null;
    const requestedByUser = requestedById || requestedByEmail || displayName
      ? {id:requestedById ? String(requestedById) : null,email:requestedByEmail,displayName}
      : null;
    return {
      id:String(row.id),email:row.email ?? 'Unavailable',
      inviteType:String(row.invite_type ?? '').toLowerCase() || null,
      status:row.status ?? 'pending',memberRole:roleName(row.member_role) ?? 'employee',
      businessProfileId:row.business_profile ? String(row.business_profile) : null,
      companyName:row.company_name ?? 'Workspace invitation',
      departmentId:departmentId ? String(departmentId) : null,
      departmentName:departmentId ? (row.department_name ?? 'Department') : null,expiresAt:row.expires_at ?? null,
      requestedByUser,canAct:Boolean(canAct)
    };
  };
  const findInvitation = (trx, inviteId) => trx('request_invites as invite')
    .leftJoin('business_profiles as profile','profile.id','invite.business_profile')
    .leftJoin('departments as department','department.id','invite.department')
    .leftJoin('directus_users as requested_by_user','requested_by_user.id','invite.requested_by_user')
    .select('invite.id','invite.email','invite.member_role','invite.status','invite.business_profile',
      'invite.department','invite.invite_type','invite.token','invite.sent_at','invite.claimed_at',
      'invite.expires_at','invite.accepted_user','invite.requested_by_user','profile.company_name',
      'department.name as department_name','requested_by_user.id as requested_by_user_id',
      'requested_by_user.email as requested_by_user_email',
      'requested_by_user.first_name as requested_by_user_first_name',
      'requested_by_user.last_name as requested_by_user_last_name')
    .where('invite.id',inviteId).first();
  const markInviteNotificationRead = async (trx, inviteId, userId) => {
    const notification = await trx('notifications').select('id')
      .where({user:userId,link_type:'invite',link_id:String(inviteId)}).first();
    if (notification?.id) await trx('notifications').where({id:notification.id})
      .update({status:'read',read_at:trx.fn.now()});
  };

  routes.get('/invites/:inviteId', authenticate, async (req,res) => {
    const userId = req.auth.userId;
    const inviteId = String(req.params.inviteId ?? '').trim();
    if (!inviteId) return fail(res,400,'BAD_REQUEST','inviteId is required.');
    try {
      const invite = await db.transaction(async trx => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',[`wellar-invite-detail:${inviteId}:${userId}`]);
        const user = await trx('directus_users').select('id','email').where({id:userId}).first();
        const email = String(user?.email ?? '').trim().toLowerCase();
        if (!email) {
          const error = new Error('The current account email could not be verified.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const row = await findInvitation(trx,inviteId);
        if (!row || String(row.invite_type ?? '').toLowerCase() !== 'in_app' ||
            String(row.email ?? '').trim().toLowerCase() !== email) {
          const error = new Error('The requested invitation was not found.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const expired = row.expires_at && Number.isFinite(new Date(row.expires_at).getTime()) &&
          new Date(row.expires_at).getTime() <= Date.now();
        const canAct = String(row.status ?? 'pending').toLowerCase() === 'pending' && !expired;
        return invitationDetail(row,canAct);
      });
      return res.status(200).json({data:invite});
    } catch (error) {
      if (error.code === 'NOT_FOUND') return fail(res,404,'NOT_FOUND',error.message);
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] invitation detail failed');
      return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
    }
  });

  routes.post('/invites/:inviteId/accept', authenticate, async (req,res) => {
    const userId = req.auth.userId;
    const inviteId = String(req.params.inviteId ?? '').trim();
    if (!inviteId) return fail(res,400,'BAD_REQUEST','inviteId is required.');
    try {
      const result = await db.transaction(async trx => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',[`wellar-invite-accept:${inviteId}:${userId}`]);
        const roles = getRoleIds(env);
        const roleRows = await trx('directus_roles').select('id').whereIn('id',Object.values(roles));
        if (roleRows.length !== 4) {
          const error = new Error('One or more Wellar role mappings do not match an existing Directus role.');
          error.code = 'CONFIGURATION_ERROR'; throw error;
        }
        const user = await trx('directus_users').select('id','email').where({id:userId}).first();
        const email = String(user?.email ?? '').trim().toLowerCase();
        if (!email) {
          const error = new Error('The current account email could not be verified.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const invite = await findInvitation(trx,inviteId);
        if (!invite || String(invite.invite_type ?? '').toLowerCase() !== 'in_app') {
          const error = new Error('The requested invitation was not found.');
          error.code = 'NOT_FOUND'; throw error;
        }
        if (String(invite.email ?? '').trim().toLowerCase() !== email) {
          const error = new Error('This invitation must be accepted using the invited email address.');
          error.code = 'FORBIDDEN'; throw error;
        }
        const status = String(invite.status ?? 'pending').toLowerCase();
        const expired = invite.expires_at && Number.isFinite(new Date(invite.expires_at).getTime()) &&
          new Date(invite.expires_at).getTime() <= Date.now();
        if (expired) {
          const error = new Error('Invitation expired.');
          error.code = 'CONFLICT'; throw error;
        }
        const existing = await trx('business_profile_members').select('id','status','member_role','business_profile','department')
          .where({user:userId,business_profile:invite.business_profile,status:'active'}).first();
        if (status === 'pending') {
          if (invite.department) {
            const department = await trx('departments').select('id','is_active','business_profile')
              .where({id:invite.department,business_profile:invite.business_profile}).first();
            if (!department?.id || department.is_active === false) {
              const error = new Error('The invitation department is no longer valid or active.');
              error.code = 'CONFLICT'; throw error;
            }
          }
          if (existing?.id) {
            await trx('request_invites').where({id:invite.id}).update({
              status:'claimed',accepted_user:userId,claimed_at:trx.fn.now()
            });
            await markInviteNotificationRead(trx,invite.id,userId);
            return {
              ok:true,message:'Invitation already accepted.',inviteId:String(invite.id),
              status:'claimed',canAct:false,businessProfileId:String(invite.business_profile),
              membershipId:String(existing.id),memberRole:roleName(existing.member_role) ?? roleName(invite.member_role) ?? 'employee',
              departmentId:existing.department ?? invite.department ?? null,inviteType:'in_app'
            };
          }
          const memberRole = roleName(invite.member_role) ?? 'employee';
          const [membership] = await trx('business_profile_members').insert({
            user:userId,business_profile:invite.business_profile,member_role:memberRole,
            department:invite.department ?? null,status:'active',joined_at:trx.fn.now()
          }).returning(['id','business_profile','member_role','department']);
          if (!membership?.id) throw new Error('Invite acceptance did not return a membership id.');
          await trx('request_invites').where({id:invite.id}).update({
            status:'claimed',accepted_user:userId,claimed_at:trx.fn.now()
          });
          await markInviteNotificationRead(trx,invite.id,userId);
          return {
            ok:true,message:'Invitation accepted. The organization is now available in Profile → Switch Organization.',
            inviteId:String(invite.id),status:'claimed',canAct:false,
            businessProfileId:String(membership.business_profile ?? invite.business_profile),
            membershipId:String(membership.id),memberRole:roleName(membership.member_role) ?? memberRole,
            departmentId:membership.department ?? invite.department ?? null,inviteType:'in_app'
          };
        }
        if (status === 'claimed' || status === 'accepted') {
          if (String(invite.accepted_user) === userId && existing?.id) {
            await markInviteNotificationRead(trx,invite.id,userId);
            return {
              ok:true,message:'Invitation already accepted.',inviteId:String(invite.id),
              status:'claimed',canAct:false,businessProfileId:String(invite.business_profile),
              membershipId:String(existing.id),memberRole:roleName(existing.member_role) ?? roleName(invite.member_role) ?? 'employee',
              departmentId:existing.department ?? invite.department ?? null,inviteType:'in_app'
            };
          }
          const error = new Error('This invitation has already been claimed.');
          error.code = 'CONFLICT'; throw error;
        }
        const error = new Error('This invitation is no longer pending.');
        error.code = 'CONFLICT'; throw error;
      });
      return res.status(200).json({data:result});
    } catch (error) {
      if (error.code === 'FORBIDDEN') return fail(res,403,'FORBIDDEN',error.message);
      if (error.code === 'NOT_FOUND') return fail(res,404,'NOT_FOUND',error.message);
      if (error.code === 'CONFLICT') return fail(res,409,'CONFLICT',error.message);
      if (error.code === 'CONFIGURATION_ERROR') return fail(res,503,'CONFIGURATION_ERROR',error.message);
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] invitation acceptance failed');
      return fail(res,500,'INTERNAL_ERROR','An unexpected error occurred.');
    }
  });

  routes.post('/invites/:inviteId/decline', authenticate, async (req,res) => {
    const userId = req.auth.userId;
    const inviteId = String(req.params.inviteId ?? '').trim();
    if (!inviteId) return fail(res,400,'BAD_REQUEST','inviteId is required.');
    try {
      const result = await db.transaction(async trx => {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))',[`wellar-invite-decline:${inviteId}:${userId}`]);
        const user = await trx('directus_users').select('id','email').where({id:userId}).first();
        const email = String(user?.email ?? '').trim().toLowerCase();
        if (!email) {
          const error = new Error('The current account email could not be verified.');
          error.code = 'NOT_FOUND'; throw error;
        }
        const invite = await findInvitation(trx,inviteId);
        if (!invite || String(invite.invite_type ?? '').toLowerCase() !== 'in_app') {
          const error = new Error('The requested invitation was not found.');
          error.code = 'NOT_FOUND'; throw error;
        }
        if (String(invite.email ?? '').trim().toLowerCase() !== email) {
          const error = new Error('This invitation must be accepted using the invited email address.');
          error.code = 'FORBIDDEN'; throw error;
        }
        const status = String(invite.status ?? 'pending').toLowerCase();
        const expired = invite.expires_at && Number.isFinite(new Date(invite.expires_at).getTime()) &&
          new Date(invite.expires_at).getTime() <= Date.now();
        if (expired) {
          const error = new Error('Invitation expired.');
          error.code = 'CONFLICT'; throw error;
        }
        if (status === 'revoked') {
          await markInviteNotificationRead(trx,invite.id,userId);
          return {
            ok:true,message:'Invitation already declined.',inviteId:String(invite.id),
            status:'revoked',canAct:false,businessProfileId:String(invite.business_profile),
            membershipId:null,memberRole:roleName(invite.member_role) ?? 'employee',
            departmentId:invite.department ?? null,inviteType:'in_app'
          };
        }
        if (status === 'claimed' || status === 'accepted') {
          const error = new Error('This invitation has already been claimed.');
          error.code = 'CONFLICT'; throw error;
        }
        await trx('request_invites').where({id:invite.id}).update({status:'revoked',claimed_at:null});
        await markInviteNotificationRead(trx,invite.id,userId);
        return {
          ok:true,message:'Invitation declined.',inviteId:String(invite.id),
          status:'revoked',canAct:false,businessProfileId:String(invite.business_profile),
          membershipId:null,memberRole:roleName(invite.member_role) ?? 'employee',
          departmentId:invite.department ?? null,inviteType:'in_app'
        };
      });
      return res.status(200).json({data:result});
    } catch (error) {
      if (error.code === 'FORBIDDEN') return fail(res,403,'FORBIDDEN',error.message);
      if (error.code === 'NOT_FOUND') return fail(res,404,'NOT_FOUND',error.message);
      if (error.code === 'CONFLICT') return fail(res,409,'CONFLICT',error.message);
      req.log?.error?.({errorName:error.name,errorCode:error.code},'[wisepace] invitation decline failed');
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
