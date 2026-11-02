import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { isEditableGrant, pageAccessState, requireAccess } from '$lib/server/access';
import { moderatorDbStatus } from '$lib/moderator-db-status';
import {
  GrantConflictError,
  GrantHistoryUnavailableError,
  changePageRoles,
  historyUnavailableMessage,
  listPageAccessChanges,
  readPageAccessGrants,
  type PageAccessChange,
} from '$lib/server/page-access';
import { NO_ROLE_CATALOGUE, grantableRoles } from '$lib/server/roles';
import { usersByIds } from '$lib/server/users.service';

const RECENT_CHANGES = 50;

// A history that can't be read must not take the editing surface down; saving still refuses without it.
async function recentChanges(): Promise<{
  changes: (PageAccessChange & { actorName: string | null })[];
  historyError: string | null;
}> {
  try {
    const rows = await listPageAccessChanges(RECENT_CHANGES);
    const names = await usersByIds(rows.map((r) => r.actorId));
    return {
      changes: rows.map((r) => ({ ...r, actorName: names.get(r.actorId)?.username ?? null })),
      historyError: null,
    };
  } catch (e) {
    console.error('[admin] permission history unavailable', e);
    return { changes: [], historyError: historyUnavailableMessage(moderatorDbStatus(e)) };
  }
}

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  const [roles, grants, history] = await Promise.all([
    grantableRoles(),
    readPageAccessGrants(),
    recentChanges(),
  ]);
  if (!roles) error(503, NO_ROLE_CATALOGUE);
  // `wide`: one column per hub role, and the role count only grows — capped at reading width the
  // matrices scrolled sideways long before the screen ran out.
  return { roles, ...pageAccessState({ grants, roles }), ...history, wide: true };
};

const changesSchema = z.record(z.string(), z.array(z.string()));

export const actions: Actions = {
  save: async ({ request, locals, url }) => {
    // The hook gates this too, but this action rewrites who can reach every page in the app — it should
    // not be one `PUBLIC_PATHS` edit away from having no check of its own.
    requireAccess(locals.user, url.pathname);
    const form = await request.formData();

    let changes: Record<string, string[]>;
    let expect: Record<string, string[]>;
    try {
      changes = changesSchema.parse(JSON.parse(String(form.get('changes') ?? '{}')));
      // The roles each changed path showed when the page loaded. Without it a save silently reverts
      // anything changed since, including by the API while this page sat open.
      expect = changesSchema.parse(JSON.parse(String(form.get('expect') ?? '{}')));
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
      if (!isEditableGrant(path)) return fail(400, { error: `${path} is not editable.` });
      // A page loaded before `expect` existed would otherwise save with no compare-and-set at all.
      if (!(path in expect))
        return fail(400, {
          error:
            'This page is out of date, so nothing was saved. Reload it and re-apply your changes.',
        });
      // The catalogue is re-read here, so a role deleted between load and save lands on an operator who
      // did nothing wrong. Name it and say the save is intact — "unknown role" reads as a bug in the page.
      const retired = roles.filter((role) => !grantable.includes(role));
      if (retired.length)
        return fail(400, {
          error: `${retired.join(
            ', '
          )} no longer exists in the auth hub, so nothing was saved. Reload the page and re-apply your changes.`,
        });
      entries.push({ path, roles: [...new Set(roles)] });
    }

    try {
      const { changed } = await changePageRoles({
        entries,
        userId: locals.user.id,
        via: 'admin-page',
        expect,
        manages: grantable,
      });
      return { success: true, count: changed.length };
    } catch (e) {
      if (e instanceof GrantConflictError)
        return fail(e.status, {
          error: `${e.message} Nothing was saved. Reload the page to see the current grants.`,
        });
      if (e instanceof GrantHistoryUnavailableError) return fail(e.status, { error: e.message });
      throw e;
    }
  },
};
