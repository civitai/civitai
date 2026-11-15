import { randomUUID } from 'crypto';
import { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';
import { NON_USER_SCOPES, TokenScope, tokenScopeLabels } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { APP_BLOCK_OAUTH_CLIENT_ID_PREFIX } from '$lib/server/oauth/block-guard';
import { SYSTEM_USER_ID } from '$lib/server/oauth/constants';
import { firstNonSkipConsentRedirectUri } from '$lib/server/oauth/redirect-uri';

// System OAuth apps: registered apps owned by the civitai system account (User id -1), the first-party
// convention Civitai Link already uses. Staff manage them on /admin/access; only they may skip the
// consent screen or carry their own token limit. Nobody signs in as the system account, so these apps
// are created, edited and handed over here, never edited from the main site's OAuth Apps card.

export { SYSTEM_USER_ID };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Scopes a system app may be granted here: every user-grantable scope (UserRead is always included). */
export const SYSTEM_APP_SCOPE_OPTIONS = Object.entries(tokenScopeLabels)
  .map(([bit, label]) => ({ bit: Number(bit), label }))
  .filter(({ bit }) => (bit & NON_USER_SCOPES) === 0);

export type SystemClientDetails = {
  name: string;
  description: string;
  redirectUris: string[];
};

export type SystemClientInput = SystemClientDetails & {
  isConfidential: boolean;
  allowedScopes: number;
};

/**
 * Parse the name, description and redirect URIs of the register and edit forms. Redirect URIs must be
 * absolute https, or http on a loopback host for local development, matching what the hub's redirect
 * matching expects.
 */
export function parseSystemClientDetails(data: FormData): SystemClientDetails | { error: string } {
  const name = String(data.get('name') ?? '').trim();
  const description = String(data.get('description') ?? '').trim();
  if (!name || name.length > 100) return { error: 'Enter a name of up to 100 characters.' };
  if (description.length > 500) return { error: 'Keep the description to 500 characters.' };

  const redirectUris = String(data.get('redirectUris') ?? '')
    .split(/\s+/)
    .filter(Boolean);
  if (redirectUris.length === 0) return { error: 'Enter at least one redirect URI.' };
  for (const uri of redirectUris) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return { error: `Not a valid URL: ${uri}` };
    }
    const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !loopback) {
      return { error: `Redirect URIs must use https (or http on localhost): ${uri}` };
    }
    if (url.hash) return { error: `Redirect URIs cannot have a #fragment: ${uri}` };
  }
  return { name, description, redirectUris };
}

/** Parse the register form: the details, plus the app type and its scopes. */
export function parseSystemClientInput(data: FormData): SystemClientInput | { error: string } {
  const details = parseSystemClientDetails(data);
  if ('error' in details) return details;

  const allowed = new Set(SYSTEM_APP_SCOPE_OPTIONS.map((o) => o.bit));
  let allowedScopes = TokenScope.UserRead;
  for (const raw of data.getAll('scope')) {
    const bit = Number(raw);
    if (!allowed.has(bit)) return { error: 'Unknown scope.' };
    allowedScopes |= bit;
  }

  return {
    ...details,
    isConfidential: data.get('isConfidential') === 'true',
    allowedScopes,
  };
}

/** The origins of these redirect URIs, skipping any that do not parse (only older rows can hold one). */
const originsOf = (redirectUris: string[]) => [
  ...new Set(
    redirectUris.flatMap((uri) => {
      try {
        return [new URL(uri).origin];
      } catch {
        return [];
      }
    })
  ),
];

/** Register a system app. Returns its id and, for a confidential app, the secret — shown only once. */
export async function createSystemClient(
  input: SystemClientInput,
  actorUserId: number
): Promise<{ clientId: string; clientSecret: string | null }> {
  const clientId = randomUUID();
  const clientSecret = input.isConfidential ? generateKey(48) : null;
  await db
    .insertInto('OauthClient')
    .values({
      id: clientId,
      secret: clientSecret ? generateSecretHash(clientSecret) : null,
      name: input.name,
      description: input.description,
      redirectUris: input.redirectUris,
      allowedOrigins: originsOf(input.redirectUris),
      isConfidential: input.isConfidential,
      allowedScopes: input.allowedScopes,
      userId: SYSTEM_USER_ID,
      isVerified: true,
    })
    .execute();
  logOAuthEvent({
    type: 'client.created',
    userId: actorUserId,
    clientId,
    metadata: { owner: 'system' },
  });
  return { clientId, clientSecret };
}

/**
 * Hand an existing app to the system account. Its owner loses it from their OAuth Apps card, and so the
 * staff-only settings never benefit its developer:
 * - a confidential app gets a new secret (returned once), so the old one stops working;
 * - the `client_credentials` grant is dropped, since through it the app would act as the system account.
 * App-Block clients are provisioned and owned by their block, so they never move. Returns null when there
 * is nothing to move, and `refusedRedirectUri` when the app skips consent but has a redirect URI a
 * skip-consent app may not have.
 */
export async function moveClientToSystem(
  clientId: string,
  actorUserId: number
): Promise<{ clientSecret: string | null } | { refusedRedirectUri: string } | null> {
  if (clientId.startsWith(APP_BLOCK_OAUTH_CLIENT_ID_PREFIX)) return null;
  const client = await db
    .selectFrom('OauthClient')
    .select(['isConfidential', 'grants', 'skipConsent', 'redirectUris'])
    .where('id', '=', clientId)
    .where('userId', '!=', SYSTEM_USER_ID)
    .executeTakeFirst();
  if (!client) return null;
  const refusedRedirectUri =
    client.skipConsent && firstNonSkipConsentRedirectUri(client.redirectUris);
  if (refusedRedirectUri) return { refusedRedirectUri };

  const clientSecret = client.isConfidential ? generateKey(48) : null;
  const moved = await db
    .updateTable('OauthClient')
    .set({
      userId: SYSTEM_USER_ID,
      grants: client.grants.filter((g) => g !== 'client_credentials'),
      ...(clientSecret ? { secret: generateSecretHash(clientSecret) } : {}),
    })
    .where('id', '=', clientId)
    .where('userId', '!=', SYSTEM_USER_ID)
    .returning('id')
    .executeTakeFirst();
  if (!moved) return null;
  logOAuthEvent({
    type: 'client.updated',
    userId: actorUserId,
    clientId,
    metadata: { owner: 'system', secretRotated: !!clientSecret },
  });
  return { clientSecret };
}

/** A system app as the edit page shows it, or null when the id is not a system app. */
export async function getSystemClient(clientId: string) {
  if (clientId.startsWith(APP_BLOCK_OAUTH_CLIENT_ID_PREFIX)) return null;
  const client = await db
    .selectFrom('OauthClient')
    .select([
      'id',
      'name',
      'description',
      'redirectUris',
      'allowedOrigins',
      'isConfidential',
      'skipConsent',
    ])
    .where('id', '=', clientId)
    .where('userId', '=', SYSTEM_USER_ID)
    .executeTakeFirst();
  return client ?? null;
}

/**
 * Change a system app's name, description and redirect URIs. Allowed origins that came from the old URIs
 * follow the new ones; any other (an app moved from a developer's account can carry hand-set origins) stay.
 * Returns null when the id is not a system app, `refusedRedirectUri` when the app skips consent and one of
 * the URIs is one a skip-consent app may not have, and `conflict` when the app changed while being saved.
 */
export async function updateSystemClient(
  clientId: string,
  details: SystemClientDetails,
  actorUserId: number
): Promise<{ ok: true } | { refusedRedirectUri: string } | { conflict: true } | null> {
  const current = await getSystemClient(clientId);
  if (!current) return null;
  const refusedRedirectUri = firstNonSkipConsentRedirectUri(details.redirectUris);
  if (current.skipConsent && refusedRedirectUri) return { refusedRedirectUri };

  const fromOldUris = new Set(originsOf(current.redirectUris));
  const allowedOrigins = [
    ...new Set([
      ...current.allowedOrigins.filter((origin) => !fromOldUris.has(origin)),
      ...originsOf(details.redirectUris),
    ]),
  ];
  // Only onto the row as read: the origins are worked out from it, and skip consent was checked against it.
  const updated = await db
    .updateTable('OauthClient')
    .set({ ...details, allowedOrigins })
    .where('id', '=', clientId)
    .where('userId', '=', SYSTEM_USER_ID)
    .where('redirectUris', '=', current.redirectUris)
    .where('allowedOrigins', '=', current.allowedOrigins)
    .where('skipConsent', '=', current.skipConsent)
    .returning('id')
    .executeTakeFirst();
  if (!updated) return { conflict: true };
  logOAuthEvent({
    type: 'client.updated',
    userId: actorUserId,
    clientId,
    metadata: {
      owner: 'system',
      name: details.name,
      redirectUris: details.redirectUris,
      allowedOrigins,
    },
  });
  return { ok: true };
}
