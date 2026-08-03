import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import {
  GRANTABLE_ROLES,
  isGrantable,
  isGrantableRole,
  pageAccessState,
  requireAccess,
} from '$lib/server/access';
import { setPageRoles } from '$lib/server/page-access';

export const load: PageServerLoad = ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  return { roles: GRANTABLE_ROLES, ...pageAccessState() };
};

const changesSchema = z.record(z.string(), z.array(z.string()));

export const actions: Actions = {
  save: async ({ request, locals }) => {
    const form = await request.formData();

    let changes: Record<string, string[]>;
    try {
      changes = changesSchema.parse(JSON.parse(String(form.get('changes') ?? '{}')));
    } catch {
      return fail(400, { error: 'Could not read the submitted changes.' });
    }

    const entries: { path: string; roles: string[] }[] = [];
    for (const [path, roles] of Object.entries(changes)) {
      if (!isGrantable(path)) return fail(400, { error: `${path} is not editable.` });
      if (!roles.every(isGrantableRole)) return fail(400, { error: `Unknown role for ${path}.` });
      entries.push({ path, roles: [...new Set(roles)] });
    }

    await setPageRoles({ entries, userId: locals.user.id });
    return { success: true, count: entries.length };
  },
};
