import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import type { AccessMode } from '$lib/server/oauth/access';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { APP_BLOCK_OAUTH_CLIENT_ID_PREFIX } from '$lib/server/oauth/block-guard';
import { isSkipConsentRedirectUri } from '$lib/server/oauth/redirect-uri';
import {
  SYSTEM_APP_SCOPE_OPTIONS,
  SYSTEM_USER_ID,
  createSystemClient,
  moveClientToSystem,
  parseSystemClientInput,
} from '$lib/server/oauth/system-clients';

// OAuth apps, for staff. System apps (owned by the civitai system account) are listed with their settings:
// login gating (accessMode), skipping the consent screen (skipConsent) and their own token limit
// (tokenRateLimit); the last two are for system apps only, and both need a confidential app (with a secret):
// a public app never skips consent, and only a client that proves its secret is charged to its own limit. Any other app is found by search, to gate its
// login or move it to the system account. Who holds the `tester` role is on /admin/roles.

const ACCESS_MODES: AccessMode[] = ['open', 'testers', 'disabled'];
const isAccessMode = (v: string): v is AccessMode => (ACCESS_MODES as string[]).includes(v);
// Far above any real per-minute volume; keeps a typo from becoming "unlimited".
const MAX_TOKEN_RATE_LIMIT = 100_000;

// The likeliest failure writing an app owned by User -1: an environment without the system account row.
const NO_SYSTEM_ACCOUNT = `Could not save. Check that the civitai system account (User id ${SYSTEM_USER_ID}) exists here.`;

const COLUMNS = [
  'id',
  'name',
  'accessMode',
  'isVerified',
  'isConfidential',
  'skipConsent',
  'tokenRateLimit',
] as const;

export const load: PageServerLoad = async ({ url }) => {
  const q = (url.searchParams.get('q') ?? '').trim();

  const system = await db
    .selectFrom('OauthClient')
    .select(COLUMNS)
    .where('userId', '=', SYSTEM_USER_ID)
    .where('id', 'not like', `${APP_BLOCK_OAUTH_CLIENT_ID_PREFIX}%`)
    .orderBy('name', 'asc')
    .execute();

  // Search the other apps by name or id — escape LIKE wildcards so they're matched literally.
  const term = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const searchResults = q
    ? await db
        .selectFrom('OauthClient')
        .select(COLUMNS)
        .where('userId', '!=', SYSTEM_USER_ID)
        .where('id', 'not like', `${APP_BLOCK_OAUTH_CLIENT_ID_PREFIX}%`)
        .where((eb) => eb.or([eb('name', 'ilike', term), eb('id', 'ilike', term)]))
        .orderBy('name', 'asc')
        .limit(25)
        .execute()
    : [];

  return {
    system,
    searchResults,
    q,
    scopeOptions: SYSTEM_APP_SCOPE_OPTIONS,
    userReadBit: TokenScope.UserRead,
  };
};

type ClientScope = 'any' | 'system' | 'confidential-system';
const NOT_FOUND: Record<ClientScope, string> = {
  any: 'That client no longer exists.',
  system: 'That system app no longer exists.',
  'confidential-system': 'Only a confidential system app (one with a secret) can use this.',
};

/** Update one OauthClient within `scope`, or a failure if there is none. */
async function updateClient(
  action: string,
  id: string,
  values: { accessMode?: AccessMode; skipConsent?: boolean; tokenRateLimit?: number | null },
  scope: ClientScope = 'any'
) {
  let query = db.updateTable('OauthClient').set(values).where('id', '=', id);
  if (scope !== 'any') query = query.where('userId', '=', SYSTEM_USER_ID);
  if (scope === 'confidential-system') query = query.where('isConfidential', '=', true);
  const updated = await query.returning('id').executeTakeFirst();
  return updated ? null : fail(404, { action, id, error: NOT_FOUND[scope] });
}

export const actions: Actions = {
  // Set a client's access mode.
  setMode: async ({ request }) => {
    const data = await request.formData();
    const id = String(data.get('id') ?? '');
    const accessMode = String(data.get('accessMode') ?? '');
    if (!id) return fail(400, { action: 'setMode', error: 'Missing client id.' });
    if (!isAccessMode(accessMode)) {
      return fail(400, { action: 'setMode', id, error: 'Invalid access mode.' });
    }
    const missing = await updateClient('setMode', id, { accessMode });
    if (missing) return missing;
    return { action: 'setMode', success: true, id, accessMode };
  },

  // Let signed-in users through /authorize with no consent screen. Confidential system apps only, and only
  // when every registered redirect URI is https off loopback.
  setSkipConsent: async ({ request, locals }) => {
    const data = await request.formData();
    const id = String(data.get('id') ?? '');
    const value = String(data.get('skipConsent') ?? '');
    if (!id) return fail(400, { action: 'setSkipConsent', error: 'Missing client id.' });
    if (value !== 'true' && value !== 'false') {
      return fail(400, { action: 'setSkipConsent', id, error: 'Invalid value.' });
    }
    const skipConsent = value === 'true';
    // Turning it off is always allowed; turning it on needs a confidential app with only https, non-loopback
    // redirect URIs.
    if (skipConsent) {
      const client = await db
        .selectFrom('OauthClient')
        .select('redirectUris')
        .where('id', '=', id)
        .where('userId', '=', SYSTEM_USER_ID)
        .executeTakeFirst();
      const refused = client?.redirectUris.find((uri) => !isSkipConsentRedirectUri(uri));
      if (refused) {
        return fail(400, {
          action: 'setSkipConsent',
          id,
          error: `Skipping consent needs every redirect URI to be https and not localhost. Remove ${refused} first.`,
        });
      }
    }
    const scope = skipConsent ? 'confidential-system' : 'system';
    const missing = await updateClient('setSkipConsent', id, { skipConsent }, scope);
    if (missing) return missing;
    logOAuthEvent({
      type: 'client.updated',
      userId: locals.user!.id,
      clientId: id,
      metadata: { owner: 'system', skipConsent },
    });
    return { action: 'setSkipConsent', success: true, id, skipConsent };
  },

  // Set the app's own /oauth/token limit per minute, or clear it (blank) for the per-IP limit only.
  // Confidential system apps only: the limit applies once a client proves its secret.
  setTokenRateLimit: async ({ request, locals }) => {
    const data = await request.formData();
    const id = String(data.get('id') ?? '');
    const raw = String(data.get('tokenRateLimit') ?? '').trim();
    if (!id) return fail(400, { action: 'setTokenRateLimit', error: 'Missing client id.' });
    const tokenRateLimit = raw === '' ? null : Number(raw);
    if (
      tokenRateLimit !== null &&
      (!Number.isInteger(tokenRateLimit) ||
        tokenRateLimit < 1 ||
        tokenRateLimit > MAX_TOKEN_RATE_LIMIT)
    ) {
      return fail(400, {
        action: 'setTokenRateLimit',
        id,
        error: `Enter a whole number from 1 to ${MAX_TOKEN_RATE_LIMIT.toLocaleString()}, or leave it blank.`,
      });
    }
    const scope = tokenRateLimit === null ? 'system' : 'confidential-system';
    const missing = await updateClient('setTokenRateLimit', id, { tokenRateLimit }, scope);
    if (missing) return missing;
    logOAuthEvent({
      type: 'client.updated',
      userId: locals.user!.id,
      clientId: id,
      metadata: { owner: 'system', tokenRateLimit },
    });
    return { action: 'setTokenRateLimit', success: true, id, tokenRateLimit };
  },

  // Hand an app to the system account; its owner loses it from their OAuth Apps card. A confidential app
  // gets a new secret, returned once for the page to show.
  moveToSystem: async ({ request, locals }) => {
    const data = await request.formData();
    const id = String(data.get('id') ?? '');
    if (!id) return fail(400, { action: 'moveToSystem', error: 'Missing client id.' });
    let moved: Awaited<ReturnType<typeof moveClientToSystem>>;
    try {
      moved = await moveClientToSystem(id, locals.user!.id);
    } catch {
      return fail(500, { action: 'moveToSystem', id, error: NO_SYSTEM_ACCOUNT });
    }
    if (moved && 'refusedRedirectUri' in moved) {
      return fail(400, {
        action: 'moveToSystem',
        id,
        error: `This app skips the consent screen, so every redirect URI must be https and not localhost. Remove ${moved.refusedRedirectUri} first.`,
      });
    }
    if (!moved) {
      return fail(404, {
        action: 'moveToSystem',
        id,
        error: 'That app no longer exists, is already a system app, or cannot be moved.',
      });
    }
    return { action: 'moveToSystem', success: true, id, clientSecret: moved.clientSecret };
  },

  // Register a new system app. The secret is returned once, for the page to show.
  createSystemApp: async ({ request, locals }) => {
    const input = parseSystemClientInput(await request.formData());
    if ('error' in input) return fail(400, { action: 'createSystemApp', error: input.error });
    let created: Awaited<ReturnType<typeof createSystemClient>>;
    try {
      created = await createSystemClient(input, locals.user!.id);
    } catch {
      return fail(500, { action: 'createSystemApp', error: NO_SYSTEM_ACCOUNT });
    }
    const { clientId, clientSecret } = created;
    return {
      action: 'createSystemApp',
      success: true,
      id: clientId,
      clientSecret,
      name: input.name,
    };
  },
};
