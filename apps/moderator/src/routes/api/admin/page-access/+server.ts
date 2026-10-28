import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api-endpoint';
import { isEditableGrant } from '$lib/server/access';
import {
  GrantConflictError,
  GrantHistoryUnavailableError,
  changePageRoles,
} from '$lib/server/page-access';
import { NO_ROLE_CATALOGUE, grantableRoles } from '$lib/server/roles';

// Session-authenticated only: a service token has no person behind it to record, and would hold every
// grant.

export const POST = defineEndpoint({
  page: '/admin',
  summary:
    'Grant or revoke one role on one page or action grant, recorded in the permission history.',
  input: z.object({
    path: z
      .string()
      .min(1)
      .describe(
        'A page path (`/reports`) or an action grant key (`grant:assistant.use`), as /admin stores them.'
      ),
    role: z.string().min(1).describe('One auth-hub role, e.g. `moderator:mod-high-access`.'),
    op: z.enum(['grant', 'revoke']),
    expect: z
      .array(z.string())
      .describe(
        'The roles the grant holds now, as you last read them. Refused with 409 if it moved.'
      ),
    gateRef: z.string().trim().min(1).max(200).describe('The approval this change is made under.'),
    reason: z.string().trim().max(500).optional(),
  }),
  returns: '{ changed, path, before, after }. 409 carries `current`, the roles stored now.',
  notes: [
    'Send JSON in the body from this app’s own origin; query parameters are refused.',
    'Admin-only paths are refused, and the admin role is never granted. A role the auth hub does not list can be revoked once the grant holds it, never granted.',
    'Revoking a service account’s role (e.g. `system:dispute-agent`) breaks the service that uses it at once.',
  ],
  handler: async ({ path, role, op, expect, gateRef, reason }, event) => {
    const user = event.locals.user;
    if (!user) error(401, 'Not signed in.'); // defineEndpoint already refused this; narrows the type
    // The shared input collector lets the query override the body; a grant change names itself in one
    // place only.
    if (event.url.search)
      return json({ error: 'Send the change in the JSON body only.' }, { status: 400 });

    if (!isEditableGrant(path)) return json({ error: `${path} is not editable.` }, { status: 400 });
    // A role the grant holds may always be revoked: /admin has no column for one from outside the
    // catalogue (a service account's), so this is the only way to take it off. `expect` is checked
    // against the full stored row before anything is written, so naming it there proves it is stored,
    // and the revoke needs no catalogue read — it still works while the hub cannot be read.
    if (!(op === 'revoke' && expect.includes(role))) {
      const grantable = await grantableRoles();
      if (!grantable) return json({ error: NO_ROLE_CATALOGUE }, { status: 503 });
      // The super role is never in this list (`isStorableRole`), so it cannot be granted from here.
      if (!grantable.includes(role))
        return json(
          {
            error:
              op === 'grant'
                ? `${role} is not a role that can be granted.`
                : `${role} is not held by ${path} and is not a role this app grants.`,
          },
          { status: 400 }
        );
    }

    // Only the named role moves; every other stored role, retired or not, is carried as it was.
    const others = expect.filter((r) => r !== role);
    const after = op === 'grant' ? [...others, role] : others;

    try {
      const { changed } = await changePageRoles({
        entries: [{ path, roles: after }],
        userId: user.id,
        via: 'api',
        gateRef,
        reason: reason ?? null,
        expect: { [path]: expect },
      });
      return {
        changed: changed.length > 0,
        path,
        before: expect,
        after: changed[0]?.after ?? expect,
      };
    } catch (e) {
      if (e instanceof GrantConflictError)
        return json({ error: e.message, current: e.current }, { status: e.status });
      if (e instanceof GrantHistoryUnavailableError)
        return json({ error: e.message }, { status: e.status });
      throw e;
    }
  },
});
