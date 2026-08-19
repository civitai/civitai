import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import {
  isGrantable,
  isGrantablePermission,
  pageAccessState,
  requireAccess,
} from '$lib/server/access';
import { readPageAccessGrants, setPageRoles } from '$lib/server/page-access';
import { NO_ROLE_CATALOGUE, grantableRoles } from '$lib/server/roles';

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  const [roles, grants] = await Promise.all([grantableRoles(), readPageAccessGrants()]);
  if (!roles) error(503, NO_ROLE_CATALOGUE);
  return { roles, ...pageAccessState({ grants, roles }) };
};

const changesSchema = z.record(z.string(), z.array(z.string()));

export const actions: Actions = {
  save: async ({ request, locals, url }) => {
    // The hook gates this too, but this action rewrites who can reach every page in the app — it should
    // not be one `PUBLIC_PATHS` edit away from having no check of its own.
    requireAccess(locals.user, url.pathname);
    const form = await request.formData();

    let changes: Record<string, string[]>;
    try {
      changes = changesSchema.parse(JSON.parse(String(form.get('changes') ?? '{}')));
    } catch {
      return fail(400, { error: 'Could not read the submitted changes.' });
    }

    // Validated against the hub's live catalogue, so a role retired there cannot be re-saved and a role
    // added there needs no deploy to become grantable. `fail`, never `error`: an `error` thrown from an
    // action renders the nearest error page, which unmounts this one and takes the operator's entire
    // unsaved change set with it.
    const grantable = await grantableRoles();
    if (!grantable) return fail(503, { error: NO_ROLE_CATALOGUE });

    const entries: { path: string; roles: string[] }[] = [];
    for (const [path, roles] of Object.entries(changes)) {
      if (!isGrantable(path) && !isGrantablePermission(path))
        return fail(400, { error: `${path} is not editable.` });
      // The catalogue is re-read here, so a role deleted between load and save lands on an operator who
      // did nothing wrong. Name it and say the save is intact — "unknown role" reads as a bug in the page.
      const retired = roles.filter((role) => !grantable.includes(role));
      if (retired.length)
        return fail(400, {
          error: `${retired.join(', ')} no longer exists in the auth hub, so nothing was saved. Reload the page and re-apply your changes.`,
        });
      entries.push({ path, roles: [...new Set(roles)] });
    }

    await setPageRoles({ entries, userId: locals.user.id });
    return { success: true, count: entries.length };
  },
};
