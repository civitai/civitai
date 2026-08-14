import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import {
  GRANTABLE_ROLES,
  featurePagePath,
  isGrantable,
  isGrantableFeature,
  isGrantableRole,
  pageAccessState,
  requireAccess,
} from '$lib/server/access';
import { readPageAccessGrants, setPageRoles } from '$lib/server/page-access';

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  return { roles: GRANTABLE_ROLES, ...pageAccessState(await readPageAccessGrants()) };
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

    const entries: { path: string; roles: string[] }[] = [];
    for (const [path, roles] of Object.entries(changes)) {
      if (!isGrantable(path) && !isGrantableFeature(path))
        return fail(400, { error: `${path} is not editable.` });
      if (!roles.every(isGrantableRole)) return fail(400, { error: `Unknown role for ${path}.` });
      entries.push({ path, roles: [...new Set(roles)] });
    }

    // `canUse` requires the page, so a feature granted to a role that does not hold it is inert — and it
    // does not stay inert: granting the page later activates it with no second decision, which is how a
    // volunteer would pick up Grant cosmetics as a side effect of being given User Lookup. Enforced here
    // rather than only in the tree, because the tree is not the only thing that writes these rows.
    const stored = await readPageAccessGrants();
    const pageRoles = (path: string) =>
      entries.find((e) => e.path === path)?.roles ?? stored[path] ?? [];
    for (const entry of entries) {
      const page = featurePagePath(entry.path);
      if (!page) continue;
      const allowed = pageRoles(page);
      entry.roles = entry.roles.filter((role) => allowed.includes(role));
    }

    await setPageRoles({ entries, userId: locals.user.id });
    return { success: true, count: entries.length };
  },
};
