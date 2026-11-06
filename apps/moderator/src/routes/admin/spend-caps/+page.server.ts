import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { SUPER_ROLE, isSuper } from '$lib/server/access';
import { moderatorDbStatus } from '$lib/moderator-db-status';
import { int4Id, parseForm } from '$lib/server/query';
import { NO_ROLE_CATALOGUE, grantableRoles } from '$lib/server/roles';
import { usersByIds } from '$lib/server/users.service';
import {
  DEFAULT_DAILY_USD,
  MAX_DAILY_USD,
  SpendCapConflictError,
  SpendCapUnavailableError,
  changeSpendCap,
  listSpendCapChanges,
  listSpendCaps,
  spendCapUnavailableMessage,
} from '$lib/server/assistant/spend-cap';

const RECENT_CHANGES = 50;

// `/admin` admits only the admin role; each action checks again, so moving or regranting the page
// cannot widen who may raise a spending limit.
const isAdmin = (locals: App.Locals) => isSuper(locals.user);

// The roles a cap can name: the hub's, plus the admin role, which `/admin` never grants.
async function cappableRoles() {
  const roles = await grantableRoles();
  return roles && [SUPER_ROLE, ...roles];
}

export const load: PageServerLoad = async ({ locals }) => {
  if (!isAdmin(locals)) error(403, 'Admins only.');
  const roles = await cappableRoles();
  if (!roles) error(503, NO_ROLE_CATALOGUE);
  const [caps, changes] = await Promise.all([
    listSpendCaps(),
    listSpendCapChanges(RECENT_CHANGES),
  ]).catch((e) => {
    console.error('[admin] spend caps unavailable', e);
    error(503, spendCapUnavailableMessage(moderatorDbStatus(e)));
  });
  const userIds = [
    ...caps.filter((c) => c.scope === 'user').map((c) => Number(c.subject)),
    ...changes.map((c) => c.actorId),
    ...changes.filter((c) => c.scope === 'user').map((c) => Number(c.subject)),
  ];
  const names = await usersByIds(userIds);
  const nameOf = (id: number) => names.get(id)?.username ?? null;
  return {
    defaultUsd: DEFAULT_DAILY_USD,
    roles: roles.map((role) => ({
      role,
      usd: caps.find((c) => c.scope === 'role' && c.subject === role)?.usd ?? null,
    })),
    // A cap on a role the hub has since retired still applies to nobody, but stays visible to remove.
    retiredRoleCaps: caps.filter((c) => c.scope === 'role' && !roles.includes(c.subject)),
    users: caps
      .filter((c) => c.scope === 'user')
      .map((c) => ({ userId: Number(c.subject), username: nameOf(Number(c.subject)), usd: c.usd })),
    changes: changes.map((c) => ({
      ...c,
      actorName: nameOf(c.actorId),
      subjectName: c.scope === 'user' ? nameOf(Number(c.subject)) : null,
    })),
  };
};

// Blank means "no cap of its own". Two decimals at most: the column is numeric(8, 2), and a value it
// would round is not the value the admin typed.
const usdField = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\d{1,6}(\.\d{1,2})?$/.test(v), {
    message: `A cap is dollars and cents, from 0 to ${MAX_DAILY_USD}, or blank for none.`,
  })
  .transform((v) => (v === '' ? null : Number(v)));

const capSchema = z.object({
  scope: z.enum(['role', 'user']),
  subject: z.string().trim().min(1),
  usd: usdField,
  // The cap the form showed when the page loaded, so a save cannot silently revert a change since.
  expect: usdField,
  reason: z
    .string()
    .trim()
    .max(500, 'Keep the reason under 500 characters.')
    .transform((v) => v || null),
});

export const actions: Actions = {
  save: async ({ request, locals }) => {
    if (!isAdmin(locals)) return fail(403, { error: 'Admins only.' });
    const input = parseForm(capSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    let subject = input.subject;
    if (input.scope === 'user') {
      const id = int4Id.safeParse(input.subject);
      if (!id.success) return fail(400, { error: 'A user override needs a user id.' });
      if (input.usd !== null && !(await usersByIds([id.data])).has(id.data))
        return fail(400, { error: `There is no user #${id.data}.` });
      subject = String(id.data);
    } else if (input.usd !== null) {
      // Removing a retired role's cap is allowed; setting one is not.
      const roles = await cappableRoles();
      if (!roles) return fail(503, { error: NO_ROLE_CATALOGUE });
      if (!roles.includes(subject))
        return fail(400, { error: `${subject} is not a role in the auth hub.` });
    }

    try {
      const { changed } = await changeSpendCap({
        scope: input.scope,
        subject,
        usd: input.usd,
        expect: input.expect,
        actorId: locals.user.id,
        reason: input.reason,
      });
      return { success: true, changed };
    } catch (e) {
      if (e instanceof SpendCapConflictError)
        return fail(e.status, {
          error: `${e.message} Nothing was saved. Reload the page to see the current caps.`,
        });
      if (e instanceof SpendCapUnavailableError) return fail(e.status, { error: e.message });
      throw e;
    }
  },
};
