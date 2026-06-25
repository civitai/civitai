import { redirect, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { scopeLabels } from '$lib/server/oauth/scope';
import { redirectUriMatches } from '$lib/server/oauth/redirect-uri';
import { isAppBlockOauthClientId } from '$lib/server/oauth/block-guard';

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

export const load: PageServerLoad = async ({ url, locals }) => {
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
  const scope = (parseInt(params.scope ?? url.searchParams.get('scope') ?? '0', 10) || 0) | TokenScope.UserRead;
  const scopes = scopeLabels(scope);

  // Hidden-field values for the Approve form (normalized scope incl. UserRead). Typed as a Record so
  // the page can read individual keys (client_id/redirect_uri/state) for the Deny form.
  const formParams: Record<string, string> = { ...params, scope: String(scope) };

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
  };
};

export const actions: Actions = {
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
