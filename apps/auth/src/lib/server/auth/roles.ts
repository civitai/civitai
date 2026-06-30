import { db } from '../db/db';
import { invalidateSessionUser } from './session-producer';
import { invalidateRoleCache } from '../oauth/access';

export const ROLE_APPS = ['moderator', 'civitai'] as const;
const SEP = ':';

const roleSlug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `app:slug` for a new role, or null if the name is empty. */
export function roleId(app: string, name: string): string | null {
  const slug = roleSlug(name);
  return slug ? `${app}${SEP}${slug}` : null;
}

export async function listRoles() {
  const rows = await db
    .selectFrom('Role')
    .leftJoin('UserRole', 'UserRole.role', 'Role.id')
    .select(({ fn }) => ['Role.id', 'Role.description', fn.count('UserRole.userId').as('memberCount')])
    .groupBy(['Role.id', 'Role.description'])
    .orderBy('Role.id')
    .execute();
  return rows.map((r) => ({ id: r.id, description: r.description, memberCount: Number(r.memberCount) }));
}

export function getRole(id: string) {
  return db.selectFrom('Role').select(['id', 'description']).where('id', '=', id).executeTakeFirst();
}

export async function createRole(id: string, description: string | null, createdById: number | null) {
  const inserted = await db
    .insertInto('Role')
    .values({ id, description, createdById })
    .onConflict((oc) => oc.column('id').doNothing())
    .returning('id')
    .executeTakeFirst();
  return !!inserted;
}

export async function deleteRole(id: string) {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('UserRole').where('role', '=', id).execute();
    await trx.deleteFrom('Role').where('id', '=', id).execute();
  });
}

export function listMembers(role: string) {
  return db
    .selectFrom('UserRole')
    .innerJoin('User', 'User.id', 'UserRole.userId')
    .select(['UserRole.userId', 'User.username', 'UserRole.note', 'UserRole.createdAt'])
    .where('UserRole.role', '=', role)
    .orderBy('UserRole.createdAt', 'desc')
    .execute();
}

function resolveUser(raw: string) {
  return /^\d+$/.test(raw)
    ? db.selectFrom('User').select(['id', 'username']).where('id', '=', Number(raw)).executeTakeFirst()
    : db.selectFrom('User').select(['id', 'username']).where('username', 'ilike', raw).executeTakeFirst();
}

// Roles ride on the session and the OAuth gate reads `tester` through the role cache, so member writes bust both.
export async function addMember(role: string, userRaw: string, note: string | null, addedById: number | null) {
  const user = await resolveUser(userRaw);
  if (!user) return { ok: false as const, error: `No user found for "${userRaw}".` };
  const inserted = await db
    .insertInto('UserRole')
    .values({ userId: user.id, role, note, addedById })
    .onConflict((oc) => oc.columns(['userId', 'role']).doNothing())
    .returning('userId')
    .executeTakeFirst();
  if (!inserted) {
    return { ok: false as const, error: `${user.username ?? `user #${user.id}`} already holds this role.` };
  }
  await invalidateSessionUser(user.id);
  invalidateRoleCache(role);
  return { ok: true as const, user };
}

export async function removeMember(role: string, userId: number) {
  await db.deleteFrom('UserRole').where('userId', '=', userId).where('role', '=', role).execute();
  await invalidateSessionUser(userId);
  invalidateRoleCache(role);
}
