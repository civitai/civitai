import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { db } from '$lib/server/db/db';
import { invalidateRoleCache, TESTER_ROLE, type AccessMode } from '$lib/server/oauth/access';

// Admin editor for OAuth login gating (gated to admins by /admin/+layout.server.ts):
//  - per-client accessMode (open / testers / disabled) on OauthClient — read live by the /authorize gate
//    (no cache, so no invalidation needed on write)
//  - the "tester" UserRole allowlist — cached ~60s per role in access.ts, so every write invalidateRoleCache()s.

const ACCESS_MODES: AccessMode[] = ['open', 'testers', 'disabled'];
const isAccessMode = (v: string): v is AccessMode => (ACCESS_MODES as string[]).includes(v);

export const load: PageServerLoad = async ({ url }) => {
  const q = (url.searchParams.get('q') ?? '').trim();
  const cols = ['id', 'name', 'accessMode', 'isVerified'] as const;

  // Default view: only gated apps (testers/disabled). Open apps are found via search.
  const gated = await db
    .selectFrom('OauthClient')
    .select(cols)
    .where('accessMode', '!=', 'open')
    .orderBy('name', 'asc')
    .execute();

  // Search any app (incl. open) by name or id — escape LIKE wildcards so they're matched literally.
  const term = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const searchResults = q
    ? await db
        .selectFrom('OauthClient')
        .select(cols)
        .where((eb) => eb.or([eb('name', 'ilike', term), eb('id', 'ilike', term)]))
        .orderBy('name', 'asc')
        .limit(25)
        .execute()
    : [];

  const testers = await db
    .selectFrom('UserRole')
    .leftJoin('User', 'User.id', 'UserRole.userId')
    .select(['UserRole.userId', 'User.username', 'UserRole.note', 'UserRole.createdAt'])
    .where('UserRole.role', '=', TESTER_ROLE)
    .orderBy('UserRole.createdAt', 'desc')
    .execute();

  return { gated, searchResults, q, testers };
};

export const actions: Actions = {
  // Set a client's access mode.
  setMode: async ({ request }) => {
    const data = await request.formData();
    const id = String(data.get('id') ?? '');
    const accessMode = String(data.get('accessMode') ?? '');
    if (!id) return fail(400, { action: 'setMode', error: 'Missing client id.' });
    if (!isAccessMode(accessMode)) {
      return fail(400, { action: 'setMode', id, error: 'Invalid access mode.' });
    }

    const updated = await db
      .updateTable('OauthClient')
      .set({ accessMode })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    if (!updated) return fail(404, { action: 'setMode', id, error: 'That client no longer exists.' });

    return { action: 'setMode', success: true, id, accessMode };
  },

  // Add a tester to the global allowlist — by numeric user id or username.
  addTester: async ({ request, locals }) => {
    const data = await request.formData();
    const raw = String(data.get('user') ?? '').trim();
    const note = String(data.get('note') ?? '').trim() || null;
    if (!raw) return fail(400, { action: 'addTester', error: 'Enter a user id or username.' });

    // All-digits → treat as a user id; otherwise resolve the username (case-insensitive).
    const user = /^\d+$/.test(raw)
      ? await db.selectFrom('User').select(['id', 'username']).where('id', '=', Number(raw)).executeTakeFirst()
      : await db
          .selectFrom('User')
          .select(['id', 'username'])
          .where('username', 'ilike', raw)
          .executeTakeFirst();

    if (!user) {
      return fail(404, { action: 'addTester', error: `No user found for "${raw}".`, values: { note } });
    }

    const inserted = await db
      .insertInto('UserRole')
      .values({ userId: user.id, role: TESTER_ROLE, note, addedById: locals.user?.id ?? null })
      .onConflict((oc) => oc.columns(['userId', 'role']).doNothing())
      .returning('userId')
      .executeTakeFirst();

    if (!inserted) {
      return fail(409, {
        action: 'addTester',
        error: `${user.username ?? `user #${user.id}`} is already a tester.`,
      });
    }

    invalidateRoleCache(TESTER_ROLE);
    return { action: 'addTester', success: true, username: user.username ?? `user #${user.id}` };
  },

  // Remove a tester (the "tester" role) from a user.
  removeTester: async ({ request }) => {
    const data = await request.formData();
    const userId = Number(data.get('userId'));
    if (!Number.isInteger(userId)) return fail(400, { action: 'removeTester', error: 'Missing user id.' });

    await db
      .deleteFrom('UserRole')
      .where('userId', '=', userId)
      .where('role', '=', TESTER_ROLE)
      .execute();
    invalidateRoleCache(TESTER_ROLE);
    return { action: 'removeTester', success: true, userId };
  },
};
