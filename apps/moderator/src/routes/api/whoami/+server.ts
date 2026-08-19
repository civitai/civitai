import { json, type RequestHandler } from '@sveltejs/kit';
import { createSessionClient } from '@civitai/auth';
import {
  PERMISSIONS,
  applyGrants,
  resolvePermissions,
  canAccess,
  permissionGrantsSnapshot,
  grantsSnapshot,
  pageAccessState,
  navForUser,
} from '$lib/server/access';
import { loadPageAccessGrants } from '$lib/server/page-access';
import { WebhookEndpoint } from '$lib/server/webhook-endpoint';

// Why a moderator can or cannot reach a page, answered from the pod that would serve them. The gate takes
// two inputs — the session's `roles` and the loaded grants — and an empty sidebar looks identical either
// way from outside, so both are reported alongside the resulting per-path verdicts.
//
// `inProcess` is read BEFORE the reload: a token request skips the hook's own applyGrants, so it shows the
// state this pod was actually gating on, which is the half a fresh read would otherwise hide.

const sessions = createSessionClient();

export const GET: RequestHandler = WebhookEndpoint(async ({ url }) => {
  const userId = Number(url.searchParams.get('userId'));
  if (!Number.isFinite(userId)) return json({ message: 'Pass ?userId=' }, { status: 400 });

  const inProcess = grantsSnapshot();
  const loaded = await loadPageAccessGrants();
  applyGrants(loaded);

  const user = await sessions.getSessionUserById(userId);
  if (!user) return json({ userId, session: null, grants: { inProcess, loaded } }, { status: 404 });

  // Groups included: `/images` and `/audit` are real routes a moderator can be bounced off, and a
  // verdict map missing the path they named is the one question this endpoint cannot then answer.
  const access = Object.fromEntries(
    pageAccessState().paths.map((path) => [path, canAccess(user, path)])
  );
  // The page verdict and the permission verdict answer different questions, and a moderator who can
  // open User Lookup but cannot send Buzz looks identical to one who cannot reach the page at all from
  // the outside — which is the confusion this endpoint exists to settle.
  //
  // Resolved for the SUBJECT, not the caller: this endpoint answers "what does user N hold", so reading
  // `locals.grants` would report the moderator running the diagnostic instead.
  const permissions = resolvePermissions(user);

  return json({
    userId,
    session: {
      username: user.username ?? null,
      isModerator: user.isModerator === true,
      roles: user.roles ?? null,
    },
    grants: {
      inProcess,
      loaded,
      effective: grantsSnapshot(),
      permissions: permissionGrantsSnapshot(),
    },
    access,
    permissions,
    nav: navForUser(user).map((link) => link.path ?? link.label),
  });
});
