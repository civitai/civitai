import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api-endpoint';
import { isGrantable, isGrantablePermission } from '$lib/server/access';
import {
  GrantConflictError,
  GrantHistoryUnavailableError,
  changePageRoles,
} from '$lib/server/page-access';
import { NO_ROLE_CATALOGUE, grantableRoles } from '$lib/server/roles';

// `/admin`'s save as a call: one role on one grant per request, so a script changes what it names and
// nothing else. Session-authenticated as an `/admin` holder only — a service token has no person
// behind it to record, and would hold every grant.

// A cross-site page can make a browser send a cookie, but not this header or a JSON body without a
// preflight this app never answers. Checked on top of SvelteKit's own origin check, which covers forms.
const CHANGE_HEADER = 'x-civitai-grant-change';

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
    `Send JSON from this app's own origin with the \`${CHANGE_HEADER}: 1\` header.`,
    'Admin-only paths, the admin role, and roles the auth hub does not list are refused.',
  ],
  handler: async ({ path, role, op, expect, gateRef, reason }, event) => {
    const { request, url } = event;
    const user = event.locals.user;
    if (!user) error(401, 'Not signed in.'); // defineEndpoint already refused this; narrows the type
    if (
      request.headers.get('origin') !== url.origin ||
      request.headers.get(CHANGE_HEADER) !== '1' ||
      !request.headers.get('content-type')?.startsWith('application/json')
    )
      return json(
        { error: `Send JSON from ${url.origin} with the ${CHANGE_HEADER}: 1 header.` },
        { status: 403 }
      );

    if (!isGrantable(path) && !isGrantablePermission(path))
      return json({ error: `${path} is not editable.` }, { status: 400 });
    const grantable = await grantableRoles();
    if (!grantable) return json({ error: NO_ROLE_CATALOGUE }, { status: 503 });
    // The super role is never in this list (`isStorableRole`), so it cannot be granted from here.
    if (!grantable.includes(role))
      return json({ error: `${role} is not a role that can be granted.` }, { status: 400 });

    // Narrowed to the live catalogue, as `/admin` does, so a retired role is not carried forward.
    const kept = expect.filter((r) => grantable.includes(r) && r !== role);
    const after = op === 'grant' ? [...kept, role] : kept;

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
        return json({ error: e.message, current: e.current }, { status: 409 });
      if (e instanceof GrantHistoryUnavailableError)
        return json({ error: e.message }, { status: 503 });
      throw e;
    }
  },
});
