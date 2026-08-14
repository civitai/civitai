import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import {
  GRANTABLE_ROLES,
  capabilitySubsetEntries,
  isGrantable,
  isGrantableCapability,
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
      if (!isGrantable(path) && !isGrantableCapability(path))
        return fail(400, { error: `${path} is not editable.` });
      if (!roles.every(isGrantableRole)) return fail(400, { error: `Unknown role for ${path}.` });
      entries.push({ path, roles: [...new Set(roles)] });
    }

    // `canUse` requires the page AND everything in `requires`, so a capability granted to a role missing
    // any of them is inert — and not stably inert: granting the missing page later activates it with no
    // second decision. Recomputed for EVERY capability, not just the submitted ones, because narrowing a
    // page has to trim the capabilities under it and a caller naming only the page would leave them
    // armed for whoever gets that page next. Enforced here rather than only in the tree, because the
    // tree is not the only thing that writes these rows.
    const stored = await readPageAccessGrants();
    const pageEntries = entries.filter((e) => !isGrantableCapability(e.path));
    const capabilityEntries = capabilitySubsetEntries(entries, stored);
    const final = [...pageEntries, ...capabilityEntries];

    // A submitted role the rule refused is worth saying out loud: silently storing fewer roles than the
    // operator ticked, under a plain success, is how they conclude a grant took effect when it did not.
    const trimmed = entries.filter((submitted) => {
      const kept = capabilityEntries.find((e) => e.path === submitted.path);
      return kept && kept.roles.length < submitted.roles.length;
    }).length;

    await setPageRoles({ entries: final, userId: locals.user.id });
    return { success: true, count: final.length, trimmed };
  },
};
