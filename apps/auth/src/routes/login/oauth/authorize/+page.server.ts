import { redirect, fail, error } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { scopeLabels } from '$lib/server/oauth/scope';
import { redirectUriMatches } from '$lib/server/oauth/redirect-uri';
import { isAppBlockOauthClientId } from '$lib/server/oauth/block-guard';
import {
  getDeviceId,
  isLinkedAndFresh,
  listAccounts,
  rollDeviceCookie,
  touchAccount,
} from '$lib/server/auth/device';
import { mintUserSession, setSessionCookie } from '$lib/server/auth/session';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';

// Consent screen for the OAuth authorization_code flow. The §D /authorize endpoint redirects here
// (303) when a user has no stored consent for the requested (client, scope). Approve POSTs straight
// back to /api/auth/oauth/authorize with `approved=true` (that endpoint issues the code + redirects to
// the client); Deny bounces to the client's redirect_uri with `error=access_denied`. Ported from the
// main app's React src/pages/login/oauth/authorize.tsx. Buzz spend-limit control is deferred (§E
// fast-follow). First-party trusted clients skip this screen entirely (Phase 2).

// Authorization params we forward verbatim into the hidden Approve form so the code-issuing POST sees
// the same request. `nonce` is included so the OIDC nonce survives the consent round-trip (the old
// React page dropped it — fixed here).
const AUTH_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'state',
  'code_challenge',
  'code_challenge_method',
  'nonce',
] as const;

export const load: PageServerLoad = async ({ url, locals, cookies }) => {
  // Must be signed in to consent — bounce to login and return here afterward.
  if (!locals.user) {
    redirect(303, `/login?returnUrl=${encodeURIComponent(url.pathname + url.search)}`);
  }

  const params: Record<string, string> = {};
  for (const key of AUTH_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null) params[key] = value;
  }

  const clientId = params.client_id;
  // App-block clients can never drive the interactive flow (mirrors the endpoint's A1 gate).
  if (!clientId || isAppBlockOauthClientId(clientId)) {
    return { invalid: true as const };
  }

  const client = await db
    .selectFrom('OauthClient')
    .select(['id', 'name', 'description', 'logoUrl', 'isVerified', 'redirectUris'])
    .where('id', '=', clientId)
    .executeTakeFirst();
  if (!client) return { invalid: true as const };

  // Validate redirect_uri up front so neither the page nor Deny can bounce to an unregistered URI.
  if (!params.redirect_uri || !redirectUriMatches(client.redirectUris, params.redirect_uri)) {
    return { invalid: true as const };
  }

  // UserRead is the forced baseline — reflect it in the displayed + submitted scope.
  const scope =
    (parseInt(params.scope ?? url.searchParams.get('scope') ?? '0', 10) || 0) | TokenScope.UserRead;
  const scopes = scopeLabels(scope);

  // Hidden-field values for the Approve form (normalized scope incl. UserRead). Typed as a Record so
  // the page can read individual keys (client_id/redirect_uri/state) for the Deny form.
  const formParams: Record<string, string> = { ...params, scope: String(scope) };

  // Account selector: the browser's linked accounts (device set), so the user can authorize as a
  // different account than the active session. Only materialized at ≥2 accounts (lazy device set), so a
  // single-account browser yields an empty list → no picker, current account auto-selected. Resolve
  // username/image the same way GET /api/auth/accounts does. Display only — switching is authorized
  // server-side against the device set (see the `switch` action).
  const deviceId = getDeviceId(cookies);
  const linked = deviceId ? await listAccounts(deviceId) : [];
  const accounts =
    linked.length >= 2
      ? await Promise.all(
          linked.map(async ({ userId }) => {
            const account = await getOrProduceSessionUser(userId).catch(() => null);
            return {
              userId,
              username: account?.username,
              image: account?.image,
              active: locals.user?.id === userId,
            };
          })
        )
      : [];

  return {
    invalid: false as const,
    client: {
      name: client.name,
      description: client.description,
      logoUrl: client.logoUrl,
      isVerified: client.isVerified,
    },
    scopes,
    params: formParams,
    accounts,
  };
};

export const actions: Actions = {
  // Switch — authorize as a different linked account, then reload the consent screen as that account so
  // Approve issues the code for it. Mirrors POST /api/auth/switch (the device-level switch): authorized by
  // BOTH an active session AND the target being linked to THIS browser's device set and fresh (<30d) — never
  // a client-supplied credential. All the original auth params are forwarded as hidden fields and copied
  // back onto the consent redirect so the in-flight request survives the round-trip.
  switch: async ({ request, cookies, locals, url }) => {
    // SameSite=Lax on civ-token already blocks a cross-site POST from carrying the session (→ 401), but
    // app-wide `csrf.checkOrigin` is off (machine OAuth endpoints need it off), so add an explicit
    // same-origin guard for this session-mutating action. A present-but-mismatched Origin is rejected; a
    // missing Origin (some same-origin POSTs omit it) falls through to the session + device-link gates.
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) error(403, 'cross-site request forbidden');
    if (!locals.user) error(401, 'active session required');
    const data = await request.formData();
    const deviceId = getDeviceId(cookies);
    const targetUserId = Number(data.get('userId'));
    if (!deviceId || !Number.isFinite(targetUserId)) return fail(400, { switchError: true });

    if (targetUserId !== locals.user.id) {
      if (!(await isLinkedAndFresh(deviceId, targetUserId)))
        return fail(403, { switchError: true });
      const user = await getOrProduceSessionUser(targetUserId);
      if (!user) return fail(404, { switchError: true });
      const token = await mintUserSession(user);
      await touchAccount(deviceId, targetUserId); // slide the 30-day idle clock
      setSessionCookie(cookies, token);
      rollDeviceCookie(cookies, deviceId);
    }

    // Reload the consent screen with the original request intact (everything except our `userId` field).
    const consentUrl = new URL('/login/oauth/authorize', url.origin);
    for (const [key, value] of data.entries()) {
      if (key !== 'userId' && typeof value === 'string') consentUrl.searchParams.set(key, value);
    }
    redirect(303, consentUrl.toString());
  },

  // Deny — bounce to the client with access_denied. Re-validate redirect_uri against the client so a
  // tampered hidden field can't turn this into an open redirect.
  deny: async ({ request }) => {
    const data = await request.formData();
    const clientId = String(data.get('client_id') ?? '');
    const redirectUri = String(data.get('redirect_uri') ?? '');
    const state = String(data.get('state') ?? '');

    const client = clientId
      ? await db
          .selectFrom('OauthClient')
          .select(['redirectUris'])
          .where('id', '=', clientId)
          .executeTakeFirst()
      : undefined;
    if (!client || !redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
      return fail(400, { denyError: true });
    }

    const target = new URL(redirectUri);
    target.searchParams.set('error', 'access_denied');
    target.searchParams.set('error_description', 'The user denied the authorization request');
    if (state) target.searchParams.set('state', state);
    redirect(303, target.toString());
  },
};
