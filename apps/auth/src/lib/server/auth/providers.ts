import { createHash, randomBytes } from 'crypto';
import { env } from '$env/dynamic/private';
// Shared cross-app contract: the provider id set is defined once in @civitai/auth (the main app references the
// same ids to render buttons + deep-link here). This file owns the hub-only OAuth config/secrets for each.
import type { ProviderId } from '@civitai/auth';
export type { ProviderId };

// Minimal, dependency-free OAuth2 Authorization-Code + PKCE client. One generic flow drives
// every provider via a small config table. Secrets are read lazily from env, so a provider
// simply "turns on" once its CLIENT_ID/SECRET are present (see listEnabledProviders).
//
// NOTE: this is the hub's *upstream* login (Civitai logging the user in via Google/Discord/…),
// distinct from Civitai's own OAuth server that third parties use ("Sign in with Civitai").

export interface NormalizedProfile {
  providerAccountId: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  username?: string;
  image?: string;
}

interface ProviderDef {
  id: ProviderId;
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  /** A server-defined EXTRA scope requested ONLY on explicit user intent (`?roles=true`), never at plain login.
   *  Discord's `role_connections.write` (Linked Roles) lives here: requesting it at every login made the whole
   *  authorize fail with `invalid_scope` unless the app had a Linked Roles verification URL configured, so it's
   *  now incremental — only the /discord/link-role flow asks for it. Server-defined (not a raw query value) so
   *  a client can't inject arbitrary scopes. */
  incrementalScope?: string;
  /** Reddit wants HTTP Basic auth on the token endpoint + a User-Agent. */
  basicAuthTokenRequest?: boolean;
  userAgent?: string;
  /** Separate "list emails" endpoint (GitHub), used to recover the verified primary email when the
   *  profile omits it (private email). */
  emailsUrl?: string;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  mapProfile: (json: Record<string, unknown>) => NormalizedProfile;
}

const PROVIDERS: Record<ProviderId, ProviderDef> = {
  discord: {
    id: 'discord',
    name: 'Discord',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userinfoUrl: 'https://discord.com/api/users/@me',
    // Plain login/connect requests only identify+email (always valid). `role_connections.write` (Linked Roles)
    // is requested ON DEMAND via incrementalScope — only the /discord/link-role flow (`?roles=true`) asks for
    // it, so a login no longer fails with `invalid_scope` when the Discord app has no Linked Roles config.
    scope: 'identify email',
    incrementalScope: 'role_connections.write',
    clientId: () => env.DISCORD_CLIENT_ID,
    clientSecret: () => env.DISCORD_CLIENT_SECRET,
    mapProfile: (p) => ({
      providerAccountId: String(p.id),
      email: p.email as string | undefined,
      emailVerified: p.verified as boolean | undefined,
      username: p.username as string | undefined,
      name: (p.global_name as string) ?? (p.username as string | undefined),
      image:
        p.avatar && p.id ? `https://cdn.discordapp.com/avatars/${p.id}/${p.avatar}.png` : undefined,
    }),
  },
  google: {
    id: 'google',
    name: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    clientId: () => env.GOOGLE_CLIENT_ID,
    clientSecret: () => env.GOOGLE_CLIENT_SECRET,
    mapProfile: (p) => ({
      providerAccountId: String(p.sub),
      email: p.email as string | undefined,
      emailVerified: p.email_verified as boolean | undefined,
      name: p.name as string | undefined,
      image: p.picture as string | undefined,
    }),
  },
  github: {
    id: 'github',
    name: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
    userAgent: 'civitai-auth',
    emailsUrl: 'https://api.github.com/user/emails',
    clientId: () => env.GITHUB_CLIENT_ID,
    clientSecret: () => env.GITHUB_CLIENT_SECRET,
    // GitHub returns a null email here when it's private; fetchProfile recovers the verified primary
    // email from emailsUrl (/user/emails). Username always present.
    mapProfile: (p) => ({
      providerAccountId: String(p.id),
      email: p.email as string | undefined,
      // GitHub's /user verifies the listed email; a non-null email here is the verified primary.
      emailVerified: p.email ? true : undefined,
      name: (p.name as string) ?? (p.login as string | undefined),
      username: p.login as string | undefined,
      image: p.avatar_url as string | undefined,
    }),
  },
  reddit: {
    id: 'reddit',
    name: 'Reddit',
    authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    userinfoUrl: 'https://oauth.reddit.com/api/v1/me',
    scope: 'identity',
    basicAuthTokenRequest: true,
    userAgent: 'civitai-auth',
    clientId: () => env.REDDIT_CLIENT_ID,
    clientSecret: () => env.REDDIT_CLIENT_SECRET,
    mapProfile: (p) => ({
      providerAccountId: String(p.id),
      name: p.name as string | undefined,
      username: p.name as string | undefined,
      image: typeof p.icon_img === 'string' ? (p.icon_img as string).split('?')[0] : undefined,
    }),
  },
  // --- stub (e2e ONLY — prod-inert) ---
  // A deterministic upstream OIDC provider for the hub e2e environment: its three URLs point at the
  // in-cluster stub-oidc-server (apps/auth/e2e/stub-oidc-server.mjs), so a login through it drives the
  // GENUINE Authorization-Code + PKCE callback path without a live external provider.
  //
  // `stub` is deliberately NOT part of the shared `ProviderId` union (packages/civitai-auth) — keeping it
  // out means the main app's AccountsCard surface never learns about it. We add it to this hub-local table
  // via a contained cast (`'stub' as ProviderId`); getProvider / listEnabledProviders / the start+callback
  // routes read the table generically, so they accept it without widening the exported type.
  //
  // It is enabled ONLY when AUTH_ENABLE_STUB_PROVIDER is truthy AND its STUB_CLIENT_ID/SECRET are set
  // (see listEnabledProviders' stubEnabled gate) — so with the flag unset (prod) it never appears in the
  // provider list and /login/stub 404s (the start route rejects an unconfigured provider).
  ['stub' as ProviderId]: {
    id: 'stub' as ProviderId,
    name: 'Stub',
    // URLs are env-controlled, and tokenUrl/userinfoUrl are SERVER-SIDE fetches (the hub sends the
    // client_secret / bearer token to them) → an SSRF sink if the env were hostile. validatedStubUrl
    // fails CLOSED: only https, or http to an in-cluster Service (.svc[.cluster.local]), is accepted —
    // an IP literal / metadata endpoint / arbitrary http host yields '' (provider non-functional).
    authorizeUrl: validatedStubUrl(env.STUB_AUTHORIZE_URL),
    tokenUrl: validatedStubUrl(env.STUB_TOKEN_URL),
    userinfoUrl: validatedStubUrl(env.STUB_USERINFO_URL),
    scope: 'openid email profile',
    clientId: () => env.STUB_CLIENT_ID,
    clientSecret: () => env.STUB_CLIENT_SECRET,
    // SECURITY: the stub is a TEST upstream — it must NEVER be able to link into or impersonate a real
    // account. We force a synthetic, namespaced, UNVERIFIED identity regardless of what the stub upstream
    // returns, so findOrCreateUser can ONLY ever create a fresh stub-scoped user:
    //   - emailVerified:false skips the link-by-VERIFIED-email branch (users.ts) — the account-takeover
    //     vector (a stub claiming a moderator's email would otherwise log in AS them; the staging hub runs
    //     against a clone of prod user data, so that collision is real once the flag is on).
    //   - the reserved `.invalid` email (RFC 6761) can never collide with a real user's, so the create
    //     branch can't unique-constraint-clash either.
    // The e2e round-trip only needs A session, not a real-user one, so this costs the test nothing.
    mapProfile: (p) => {
      const sub = String(p.sub ?? p.id ?? 'anon');
      return {
        providerAccountId: sub,
        email: `stub+${sub}@stub.invalid`,
        emailVerified: false,
        name: p.name as string | undefined,
        username: p.preferred_username as string | undefined,
      };
    },
  },
};

export function getProvider(id: string): ProviderDef | undefined {
  return (PROVIDERS as Record<string, ProviderDef>)[id];
}

/** Truthy env flag check (1/true/yes/on, case-insensitive). */
const isTruthy = (v: string | undefined): boolean =>
  v != null && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());

/** The e2e-only `stub` provider is additionally gated behind an explicit flag so it can NEVER turn on in
 *  prod just because some STUB_* env happens to be set. It enables ONLY when AUTH_ENABLE_STUB_PROVIDER is
 *  truthy (the credential check below still applies on top). */
export function isStubProviderEnabled(): boolean {
  return isTruthy(env.AUTH_ENABLE_STUB_PROVIDER);
}

/**
 * Fail-closed validator for the env-controlled stub provider URLs. tokenUrl/userinfoUrl are server-side
 * fetches from the hub pod, so an unvalidated env is an SSRF primitive (fetch arbitrary internal hosts /
 * the cloud metadata endpoint; leak the client_secret/bearer). Accept ONLY https (any host) or http to an
 * in-cluster Service (`*.svc` / `*.svc.cluster.local`) — the only shapes the stub legitimately takes.
 * Anything else (bare IP, plain-http external host, junk) returns '' so the provider is non-functional.
 * (A function declaration so it's hoisted for the PROVIDERS literal above.)
 */
function validatedStubUrl(raw: string | undefined): string {
  if (!raw) return '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '';
  }
  if (u.protocol === 'https:') return raw;
  if (u.protocol === 'http:' && (u.hostname.endsWith('.svc') || u.hostname.endsWith('.svc.cluster.local')))
    return raw;
  return '';
}

/** A provider's gate beyond having client credentials. Real providers have none; `stub` requires the flag. */
function providerExtraGate(p: ProviderDef): boolean {
  return (p.id as string) === 'stub' ? isStubProviderEnabled() : true;
}

/** Providers whose client credentials are actually configured — drives the login buttons. The e2e-only
 *  `stub` provider is additionally gated behind AUTH_ENABLE_STUB_PROVIDER (prod-inert by default). */
export function listEnabledProviders(): { id: ProviderId; name: string }[] {
  return Object.values(PROVIDERS)
    .filter((p) => !!p.clientId() && !!p.clientSecret() && providerExtraGate(p))
    .map((p) => ({ id: p.id, name: p.name }));
}

// --- PKCE ---
const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPkce() {
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

export function buildAuthorizeUrl(
  provider: ProviderDef,
  opts: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    prompt?: string | null;
    /** Request the provider's server-defined incrementalScope too (e.g. Discord role_connections.write). */
    incremental?: boolean;
  }
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId()!);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  // Append the incremental scope only on explicit intent — server-defined, so the query can't inject scopes.
  const scope =
    opts.incremental && provider.incrementalScope
      ? `${provider.scope} ${provider.incrementalScope}`
      : provider.scope;
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (provider.id === 'reddit') url.searchParams.set('duration', 'temporary');
  // Forward an OIDC `prompt` (e.g. `select_account`) so the "add another account" flow can pick a DIFFERENT
  // identity on the provider instead of silently reusing the current provider session. Only Google honors
  // `select_account`; GitHub/Discord/Reddit ignore unknown values, so this is a safe no-op for them.
  if (opts.prompt) url.searchParams.set('prompt', opts.prompt);
  return url.toString();
}

export async function exchangeCode(
  provider: ProviderDef,
  opts: { code: string; redirectUri: string; codeVerifier: string }
): Promise<{ accessToken: string; scope: string | null }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (provider.userAgent) headers['user-agent'] = provider.userAgent;
  if (provider.basicAuthTokenRequest) {
    const basic = Buffer.from(`${provider.clientId()}:${provider.clientSecret()}`).toString(
      'base64'
    );
    headers['authorization'] = `Basic ${basic}`;
  } else {
    body.set('client_id', provider.clientId()!);
    body.set('client_secret', provider.clientSecret()!);
  }

  const res = await fetch(provider.tokenUrl, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`[${provider.id}] token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token?: string; scope?: string };
  if (!json.access_token) throw new Error(`[${provider.id}] no access_token in response`);
  // `scope` is the space-delimited set the provider actually GRANTED (may differ from what we requested if the
  // user unchecked one). Stored on the Account so e.g. the Discord linked-roles flow can detect its scope.
  return { accessToken: json.access_token, scope: json.scope ?? null };
}

export async function fetchProfile(
  provider: ProviderDef,
  accessToken: string
): Promise<NormalizedProfile> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (provider.userAgent) headers['user-agent'] = provider.userAgent;
  const res = await fetch(provider.userinfoUrl, { headers });
  if (!res.ok) throw new Error(`[${provider.id}] userinfo failed: ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  const profile = provider.mapProfile(json);

  // Recover a missing email from the provider's emails endpoint (GitHub hides the email by default).
  // The verified primary email is what account-linking-by-email keys on, so without this a GitHub
  // user with a private email would create a duplicate account instead of linking. Best-effort.
  if (provider.emailsUrl && !profile.email) {
    try {
      const eRes = await fetch(provider.emailsUrl, { headers });
      if (eRes.ok) {
        const emails = (await eRes.json()) as Array<{
          email: string;
          primary?: boolean;
          verified?: boolean;
        }>;
        const best = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
        if (best) {
          profile.email = best.email;
          profile.emailVerified = true;
        }
      }
    } catch {
      // best-effort — proceed with no email (the user can add/verify one later)
    }
  }

  return profile;
}
