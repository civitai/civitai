import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { db } from '$lib/server/db/db';
import type { AccessMode } from '$lib/server/oauth/access';

// Per-client OAuth accessMode (open / testers / disabled). Who holds the `tester` role is on /admin/roles.

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

  return { gated, searchResults, q };
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
};
