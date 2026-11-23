import { generateKeyPairSync, randomUUID } from 'crypto';
import { SignJWT, base64url, importPKCS8 } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  createSessionSigner,
  isAccessTokenJwt,
  type AccessTokenJwtClaims,
  type SessionSigner,
} from '@civitai/auth';

/**
 * The auth hub's exchanged access tokens (`at+jwt`) at this source, beside the opaque tokens it
 * already accepts. The hub's key is generated here and its JWKS is served by a stubbed `fetch`, so
 * every case runs the real jose verification against a real signature.
 */

const { getSessionFromBearerTokenMock, getBearerTokenUserMock } = vi.hoisted(() => ({
  getSessionFromBearerTokenMock: vi.fn(),
  getBearerTokenUserMock: vi.fn(),
}));
vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: getSessionFromBearerTokenMock,
  getBearerTokenUser: getBearerTokenUserMock,
}));

import { authenticate } from '~/server/registry-adapter/auth';
import type { TokenUser, VerifiedToken, VerifyToken } from '~/server/registry-adapter/auth';
import {
  createHubJwtVerifier,
  hasScope,
  routeVerifyToken,
  scopeBitsAssumingUnknownIsAll,
  scopeGrantBits,
} from '~/server/registry-adapter/auth.jwt';
import {
  createCivitaiTokenVerifier,
  parseServiceClients,
  verifyOpaqueCivitaiToken,
} from '~/server/registry-adapter/auth.live';
import { ProtocolError } from '~/server/registry-adapter/protocol';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import {
  ALL_SCOPES,
  TokenScope,
  TokenScopePresets,
} from '~/shared/constants/token-scope.constants';

const ISSUER = 'https://auth.test';
const RESOURCE = 'https://apps.test';
const JWKS_URI = 'https://auth.test/.well-known/jwks.json';
const KID = 'hub-1';
// Pairwise distinct, and distinct from anything the code under test names.
const USER_ID = 4817;
const CLIENT_ID = 'app-7c2e';
const RELAY_ID = 'relay-91af';
const T0_MS = Date.UTC(2031, 0, 2, 3, 4, 5);

let signer: SessionSigner;
let otherSigner: SessionSigner;
let privateKeyPem: string;
let hubJwks: { keys: unknown[] };
let otherJwks: { keys: unknown[] };

const ecKeyPair = () =>
  generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

beforeAll(async () => {
  const kp = ecKeyPair();
  privateKeyPem = kp.privateKey;
  signer = createSessionSigner({
    privateKeyPem: kp.privateKey,
    publicKeyPem: kp.publicKey,
    kid: KID,
    issuer: ISSUER,
  });
  hubJwks = await signer.publicJwks();
  // A second key the hub does not publish (until a rotation case says it does).
  const other = ecKeyPair();
  otherSigner = createSessionSigner({
    privateKeyPem: other.privateKey,
    publicKeyPem: other.publicKey,
    kid: 'hub-2',
    issuer: ISSUER,
  });
  otherJwks = await otherSigner.publicJwks();
});

const nowS = () => Math.floor(Date.now() / 1000);

const claims = (over: Partial<AccessTokenJwtClaims> = {}): AccessTokenJwtClaims => ({
  iss: ISSUER,
  sub: String(USER_ID),
  aud: RESOURCE,
  client_id: CLIENT_ID,
  scope: 'ModelsRead MediaRead',
  jti: randomUUID(),
  iat: nowS(),
  exp: nowS() + 900,
  ...over,
});

const mint = (over: Partial<AccessTokenJwtClaims> = {}) => signer.mintAccessTokenJwt(claims(over));

/** A token signed by the hub's key with any header and payload, for the cases the signer refuses. */
async function signRaw(header: Record<string, unknown>, payload: Record<string, unknown>) {
  const key = await importPKCS8(privateKeyPem, 'ES256');
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', ...header } as { alg: string })
    .sign(key);
}

const USER: TokenUser = { showNsfw: true, browsingLevel: 31 };

let fetchMock: Mock<typeof fetch>;
let served: () => { keys: unknown[] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0_MS);
  served = () => hubJwks;
  fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(served()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  getSessionFromBearerTokenMock.mockReset();
  getBearerTokenUserMock.mockReset();
  getBearerTokenUserMock.mockResolvedValue(USER);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const hubVerifier = (
  over: { audience?: string | undefined; loadUser?: typeof getBearerTokenUserMock } = {}
) =>
  createHubJwtVerifier(
    {
      issuer: ISSUER,
      jwksUri: JWKS_URI,
      audience: 'audience' in over ? over.audience : RESOURCE,
    },
    { loadUser: over.loadUser ?? getBearerTokenUserMock }
  );

const authOpts = { regionRestricted: () => false };

async function expectInvalidToken(p: Promise<unknown>) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ProtocolError);
  expect((err as ProtocolError).code).toBe('invalid_token');
}

describe('isAccessTokenJwt', () => {
  it('is true for a JWS typed at+jwt, with or without the media-type prefix', async () => {
    expect(isAccessTokenJwt(await mint())).toBe(true);
    const prefixed = await signRaw({ typ: 'application/AT+JWT', kid: KID }, { sub: '1' });
    expect(isAccessTokenJwt(prefixed)).toBe(true);
  });

  it('is false for a session JWT, an opaque key and an untyped JWS', async () => {
    expect(isAccessTokenJwt(await signRaw({ typ: 'JWT' }, { sub: '1' }))).toBe(false);
    expect(isAccessTokenJwt(await signRaw({}, { sub: '1' }))).toBe(false);
    expect(isAccessTokenJwt('3f9a0c1d2e4b5a6978c8d7e6f5a4b3c2')).toBe(false);
    expect(isAccessTokenJwt('not.a.jwt')).toBe(false);
  });
});

describe('createHubJwtVerifier', () => {
  it('accepts a hub token for this resource, as the opaque path names the user and client', async () => {
    const token = await mint({ exp: nowS() + 600 });
    const verified = await hubVerifier()(token);
    expect(verified).toEqual({
      subject: `user:${USER_ID}/client:${CLIENT_ID}`,
      userId: USER_ID,
      clientId: CLIENT_ID,
      scope: TokenScope.ModelsRead | TokenScope.MediaRead,
      actor: null,
      user: USER,
      expiresAt: new Date((nowS() + 600) * 1000),
    });
    // The user is read as every bearer path reads it, with the token's scope as the site's bits.
    expect(getBearerTokenUserMock).toHaveBeenCalledWith(
      USER_ID,
      TokenScope.ModelsRead | TokenScope.MediaRead
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(JWKS_URI);
  });

  it('gives a relayed token (act) the same subject as a direct one', async () => {
    const verified = await hubVerifier()(await mint({ act: { sub: RELAY_ID } }));
    expect(verified?.subject).toBe(`user:${USER_ID}/client:${CLIENT_ID}`);
  });

  it('reads client_id as clientId and act.sub as actor; no act is a null actor', async () => {
    const relayed = await hubVerifier()(await mint({ act: { sub: RELAY_ID } }));
    expect(relayed).toMatchObject({ clientId: CLIENT_ID, actor: RELAY_ID });
    const direct = await hubVerifier()(await mint());
    expect(direct).toMatchObject({ clientId: CLIENT_ID, actor: null });
    // An act with no usable sub names no actor.
    const noSub = await signRaw({ typ: 'at+jwt', kid: KID }, { ...claims(), act: { iss: ISSUER } });
    expect((await hubVerifier()(noSub))?.actor).toBeNull();
    // No client_id at all: refused, so there is no token to name a client for.
    const { client_id: _c, ...noClient } = claims();
    expect(await hubVerifier()(await signRaw({ typ: 'at+jwt', kid: KID }, noClient))).toBeNull();
  });

  it('🔴 a token whose scope names nothing the site knows, or has no scope, grants no AppDataRead', async () => {
    const bogus = await hubVerifier()(await mint({ scope: 'Bogus' }));
    expect(bogus).not.toBeNull();
    expect(bogus!.scope).toBe(0n);
    expect(hasScope(bogus!, 'AppDataRead')).toBe(false);
    // The refusal check still reads the same token as every scope.
    expect(getBearerTokenUserMock).toHaveBeenLastCalledWith(USER_ID, ALL_SCOPES);

    const { scope: _scope, ...unscoped } = claims();
    const none = await hubVerifier()(await signRaw({ typ: 'at+jwt', kid: KID }, unscoped));
    expect(none).not.toBeNull();
    expect(hasScope(none!, 'AppDataRead')).toBe(false);
    expect(getBearerTokenUserMock).toHaveBeenLastCalledWith(USER_ID, ALL_SCOPES);
  });

  it('AppsRead alone grants no AppDataRead; AppDataRead does', async () => {
    const apps = await hubVerifier()(await mint({ scope: 'AppsRead' }));
    expect(hasScope(apps!, 'AppsRead')).toBe(true);
    expect(hasScope(apps!, 'AppDataRead')).toBe(false);
    const data = await hubVerifier()(await mint({ scope: 'AppsRead AppDataRead' }));
    expect(hasScope(data!, 'AppDataRead')).toBe(true);
    expect(data!.scope).toBe(TokenScope.AppsRead | TokenScope.AppDataRead);
  });

  it('refuses a token for another audience, by exact string', async () => {
    const verify = hubVerifier();
    expect(await verify(await mint({ aud: 'https://other.test' }))).toBeNull();
    expect(await verify(await mint({ aud: `${RESOURCE}/` }))).toBeNull();
    // Control: the same verifier accepts this resource's token.
    expect(await verify(await mint())).not.toBeNull();
  });

  it('refuses another issuer', async () => {
    const verify = hubVerifier();
    expect(await verify(await mint({ iss: 'https://auth.other.test' }))).toBeNull();
    expect(await verify(await mint())).not.toBeNull();
  });

  it('refuses an alg other than ES256, and alg none', async () => {
    const verify = hubVerifier();
    const payload = { ...claims() };
    const hs = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: KID })
      .sign(new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes!'));
    expect(await verify(hs)).toBeNull();
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const rs = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: KID })
      .sign(await importPKCS8(rsa.privateKey, 'RS256'));
    expect(await verify(rs)).toBeNull();
    const none = [
      base64url.encode(JSON.stringify({ alg: 'none', typ: 'at+jwt', kid: KID })),
      base64url.encode(JSON.stringify(payload)),
      '',
    ].join('.');
    expect(isAccessTokenJwt(none)).toBe(true);
    expect(await verify(none)).toBeNull();
    // Control: the same claims as an ES256 hub token pass.
    expect(await verify(await signRaw({ typ: 'at+jwt', kid: KID }, payload))).not.toBeNull();
  });

  it('refuses a token typed other than at+jwt, even signed by the hub', async () => {
    const payload = { ...claims() };
    expect(await hubVerifier()(await signRaw({ typ: 'JWT', kid: KID }, payload))).toBeNull();
  });

  it('refuses a token expired by any amount, and one not yet valid, with no clock leeway', async () => {
    const verify = hubVerifier();
    expect(await verify(await mint({ iat: nowS() - 1000, exp: nowS() - 1 }))).toBeNull();
    expect(await verify(await mint({ iat: nowS() - 1000, exp: nowS() }))).toBeNull();
    const notYet = await signRaw({ typ: 'at+jwt', kid: KID }, { ...claims(), nbf: nowS() + 1 });
    expect(await verify(notYet)).toBeNull();
    // Controls: a second before exp, and nbf now, pass.
    expect(await verify(await mint({ iat: nowS() - 1000, exp: nowS() + 1 }))).not.toBeNull();
    const nbfNow = await signRaw({ typ: 'at+jwt', kid: KID }, { ...claims(), nbf: nowS() });
    expect(await verify(nbfNow)).not.toBeNull();
  });

  it('refetches the JWKS once on an unknown kid, then refuses the token', async () => {
    const verify = hubVerifier();
    expect(await verify(await mint())).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Past jose's refetch cooldown.
    vi.setSystemTime(T0_MS + 31_000);
    const unknown = await otherSigner.mintAccessTokenJwt(claims());
    expect(await verify(unknown)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Within the cooldown, another unknown kid does not refetch.
    expect(await verify(await otherSigner.mintAccessTokenJwt(claims()))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts a rotated-in key after the refetch an unknown kid triggers', async () => {
    const verify = hubVerifier();
    expect(await verify(await mint())).not.toBeNull();
    served = () => ({ keys: [...hubJwks.keys, ...otherJwks.keys] });
    vi.setSystemTime(T0_MS + 31_000);
    expect(await verify(await otherSigner.mintAccessTokenJwt(claims()))).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws, rather than refusing the token, when the JWKS cannot be read', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }));
    await expect(hubVerifier()(await mint())).rejects.toThrow();
  });

  it('refuses a token whose user may not use a bearer', async () => {
    getBearerTokenUserMock.mockResolvedValue(null);
    expect(await hubVerifier()(await mint())).toBeNull();
    expect(getBearerTokenUserMock).toHaveBeenCalledTimes(1);
  });

  it('reads a token with no scope claim as every scope for the user check', async () => {
    const { scope: _scope, ...unscoped } = claims();
    expect(
      await hubVerifier()(await signRaw({ typ: 'at+jwt', kid: KID }, unscoped))
    ).not.toBeNull();
    expect(getBearerTokenUserMock).toHaveBeenCalledWith(USER_ID, ALL_SCOPES);
    expect(ALL_SCOPES & TokenScope.ModelsWrite).toBe(TokenScope.ModelsWrite);
  });

  it('refuses a sub that is not a user id', async () => {
    expect(await hubVerifier()(await mint({ sub: 'svc:feed' }))).toBeNull();
    expect(await hubVerifier()(await mint({ sub: '0' }))).toBeNull();
    expect(getBearerTokenUserMock).not.toHaveBeenCalled();
  });

  it('refuses a token with an empty client_id', async () => {
    const verify = hubVerifier();
    expect(await verify(await mint({ client_id: '' }))).toBeNull();
    expect(getBearerTokenUserMock).not.toHaveBeenCalled();
    // Control: the same claims with this client pass.
    expect(await verify(await mint())).not.toBeNull();
  });

  it('with no resource identifier, refuses every JWT without fetching keys', async () => {
    const verify = hubVerifier({ audience: undefined });
    expect(await verify(await mint())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('scopeBitsAssumingUnknownIsAll (the refusal check)', () => {
  it('maps scope names to the site bits, and an unknown name to every scope', () => {
    expect(scopeBitsAssumingUnknownIsAll('ModelsRead MediaRead')).toBe(
      TokenScope.ModelsRead | TokenScope.MediaRead
    );
    expect(scopeBitsAssumingUnknownIsAll('ModelsRead NotAScope') & TokenScope.ModelsWrite).toBe(
      TokenScope.ModelsWrite
    );
  });

  it('reads the name None as every scope, like an unknown name, not as no scope', () => {
    expect(scopeBitsAssumingUnknownIsAll('None')).toBe(ALL_SCOPES);
    expect(scopeBitsAssumingUnknownIsAll('UserRead None')).toBe(ALL_SCOPES);
    // Control: UserRead alone is just its bit.
    expect(scopeBitsAssumingUnknownIsAll('UserRead')).toBe(TokenScope.UserRead);
  });

  it('fails safe on a missing or non-string scope claim: every scope, like an unknown name', () => {
    for (const scope of [undefined, null, 7, ['ModelsRead'], { ModelsRead: true }]) {
      expect(scopeBitsAssumingUnknownIsAll(scope)).toBe(ALL_SCOPES);
      expect(scopeBitsAssumingUnknownIsAll(scope) & TokenScope.ModelsWrite).toBe(
        TokenScope.ModelsWrite
      );
    }
  });
});

describe('scopeGrantBits and hasScope (does the token HOLD a scope)', () => {
  it('🔴 an unknown name grants nothing, alone or beside a known one', () => {
    expect(scopeGrantBits('Bogus')).toBe(0n);
    expect(scopeGrantBits('AppsRead Bogus')).toBe(TokenScope.AppsRead);
    expect(hasScope({ scope: scopeGrantBits('Bogus') }, 'AppDataRead')).toBe(false);
  });

  it('🔴 a missing or non-string scope claim grants nothing', () => {
    for (const scope of [undefined, null, 7, ['AppDataRead'], { AppDataRead: true }]) {
      expect(scopeGrantBits(scope)).toBe(0n);
      expect(hasScope({ scope: scopeGrantBits(scope) }, 'AppDataRead')).toBe(false);
    }
  });

  it('None grants nothing', () => {
    expect(scopeGrantBits('None')).toBe(0n);
    expect(scopeGrantBits('UserRead None')).toBe(TokenScope.UserRead);
  });

  it('AppsRead does not hold AppDataRead; AppDataRead does', () => {
    expect(hasScope({ scope: scopeGrantBits('AppsRead') }, 'AppDataRead')).toBe(false);
    expect(hasScope({ scope: scopeGrantBits('AppDataRead') }, 'AppDataRead')).toBe(true);
    expect(hasScope({ scope: scopeGrantBits('MediaRead AppDataRead') }, 'AppDataRead')).toBe(true);
  });
});

describe('routeVerifyToken', () => {
  const OPAQUE: VerifiedToken = {
    subject: 'user:9/client:opaque-client',
    userId: 9,
    clientId: 'opaque-client',
    scope: 0n,
    actor: null,
    user: { showNsfw: false, browsingLevel: 1 },
    expiresAt: null,
  };

  it('🔴 a JWT-shaped token that fails verification is invalid_token and never reaches the opaque path', async () => {
    const opaque = vi.fn<VerifyToken>(async () => OPAQUE);
    const verify = routeVerifyToken({ opaque, jwt: hubVerifier() });
    const garbage = [
      base64url.encode(JSON.stringify({ alg: 'ES256', typ: 'at+jwt', kid: KID })),
      base64url.encode('{"sub":"1"'),
      'c2lnbmF0dXJl',
    ].join('.');
    await expectInvalidToken(authenticate(`Bearer ${garbage}`, verify, authOpts));
    const forged = await otherSigner.mintAccessTokenJwt(claims());
    await expectInvalidToken(authenticate(`Bearer ${forged}`, verify, authOpts));
    expect(opaque).not.toHaveBeenCalled();
  });

  it('an opaque token goes to the opaque path unchanged, and never to the JWT path', async () => {
    const opaque = vi.fn<VerifyToken>(async () => OPAQUE);
    const jwt = vi.fn<VerifyToken>(async () => null);
    const verify = routeVerifyToken({ opaque, jwt });
    const principal = await authenticate('Bearer 3f9a0c1d2e4b5a69', verify, authOpts);
    expect(principal.subject).toBe(OPAQUE.subject);
    expect(opaque).toHaveBeenCalledWith('3f9a0c1d2e4b5a69');
    expect(jwt).not.toHaveBeenCalled();
    // A session JWT is not an access token: it takes the opaque path (and is refused there).
    await routeVerifyToken({ opaque, jwt })(await signRaw({ typ: 'JWT' }, { sub: '1' }));
    expect(jwt).not.toHaveBeenCalled();
  });
});

describe('a hub token through authenticate', () => {
  it('re-checks as active, then inactive once the token has expired', async () => {
    const verify = routeVerifyToken({ opaque: vi.fn(async () => null), jwt: hubVerifier() });
    const exp = nowS() + 120;
    const principal = await authenticate(`Bearer ${await mint({ exp })}`, verify, authOpts);
    expect(principal.subject).toBe(`user:${USER_ID}/client:${CLIENT_ID}`);
    expect(principal.expiresAt).toEqual(new Date(exp * 1000));
    expect(await principal.recheck!()).toBe('active');
    vi.setSystemTime((exp + 1) * 1000);
    expect(await principal.recheck!()).toBe('inactive');
  });

  it('re-checks as inactive once the user is banned, and audience-changed on new settings', async () => {
    const verify = routeVerifyToken({ opaque: vi.fn(async () => null), jwt: hubVerifier() });
    const principal = await authenticate(`Bearer ${await mint()}`, verify, authOpts);
    getBearerTokenUserMock.mockResolvedValueOnce({ showNsfw: false, browsingLevel: 1 });
    expect(await principal.recheck!()).toBe('audience-changed');
    getBearerTokenUserMock.mockResolvedValueOnce(null);
    expect(await principal.recheck!()).toBe('inactive');
  });

  it('a re-check while the JWKS is unreadable fails (not a finding) instead of reading inactive', async () => {
    const verify = routeVerifyToken({ opaque: vi.fn(async () => null), jwt: hubVerifier() });
    const principal = await authenticate(`Bearer ${await mint()}`, verify, authOpts);
    // Past jose's 10-minute key cache, still inside the token's 15 minutes: the re-check must
    // refetch, and the hub is down for it.
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }));
    vi.setSystemTime(T0_MS + 11 * 60_000);
    const failed = await principal.recheck!().then(
      (found) => ({ found }),
      (err: unknown) => ({ err })
    );
    expect(failed).not.toHaveProperty('found');
    expect((failed as { err: unknown }).err).not.toBeInstanceOf(ProtocolError);
    // Control: the hub back, the same re-check reads active.
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(hubJwks), { status: 200 })
    );
    expect(await principal.recheck!()).toBe('active');
  });
});

describe('verifyOpaqueCivitaiToken', () => {
  const session = (tokenScope: bigint) => ({
    user: { id: 6127, showNsfw: true, browsingLevel: 15 },
    apiKeyType: ApiKeyType.Access,
    subject: { type: 'oauth', id: 'opaque-app-3c58' },
    tokenScope,
    expiresAt: null,
  });

  it('names the OAuth client, no actor, and the scope the key stores', async () => {
    getSessionFromBearerTokenMock.mockResolvedValue(
      session(TokenScope.AppsRead | TokenScope.AppDataRead)
    );
    const verified = await verifyOpaqueCivitaiToken('9e8d7c6b5a4f3e2d');
    expect(verified).toMatchObject({
      subject: 'user:6127/client:opaque-app-3c58',
      userId: 6127,
      clientId: 'opaque-app-3c58',
      actor: null,
      scope: TokenScope.AppsRead | TokenScope.AppDataRead,
    });
    expect(hasScope(verified!, 'AppDataRead')).toBe(true);
  });

  it('🔴 a Full key does not hold AppDataRead (Full is the legacy bits only)', async () => {
    getSessionFromBearerTokenMock.mockResolvedValue(session(TokenScopePresets.Full));
    const verified = await verifyOpaqueCivitaiToken('9e8d7c6b5a4f3e2d');
    expect(verified?.scope).toBe(TokenScopePresets.Full);
    expect(hasScope(verified!, 'AppDataRead')).toBe(false);
    // Control: the same key holds a scope Full does include.
    expect(hasScope(verified!, 'ModelsRead')).toBe(true);
  });
});

describe('createCivitaiTokenVerifier', () => {
  it('sends an opaque token to the site bearer lookup, as before', async () => {
    getSessionFromBearerTokenMock.mockResolvedValue({
      user: { id: 9, showNsfw: false, browsingLevel: 1 },
      apiKeyType: ApiKeyType.Access,
      subject: { type: 'oauth', id: 'opaque-client' },
      tokenScope: TokenScope.AppsRead | TokenScope.UserRead,
      expiresAt: null,
    });
    const verify = createCivitaiTokenVerifier({ resource: RESOURCE, issuer: ISSUER });
    expect(await verify('3f9a0c1d2e4b5a69')).toEqual({
      subject: 'user:9/client:opaque-client',
      userId: 9,
      clientId: 'opaque-client',
      // The key's stored scope, as issued; no one acts for an opaque token.
      scope: TokenScope.AppsRead | TokenScope.UserRead,
      actor: null,
      user: { id: 9, showNsfw: false, browsingLevel: 1 },
      expiresAt: null,
    });
    expect(getSessionFromBearerTokenMock).toHaveBeenCalledWith('3f9a0c1d2e4b5a69');
  });

  it('accepts a hub token for its resource, reading keys from the default JWKS location', async () => {
    const verify = createCivitaiTokenVerifier({ resource: RESOURCE, issuer: `${ISSUER}/` });
    expect((await verify(await mint()))?.subject).toBe(`user:${USER_ID}/client:${CLIENT_ID}`);
    expect(String(fetchMock.mock.calls[0][0])).toBe(JWKS_URI);
    expect(getSessionFromBearerTokenMock).not.toHaveBeenCalled();
  });

  it('with the resource unset, refuses hub tokens without the opaque lookup', async () => {
    const verify = createCivitaiTokenVerifier({ resource: undefined, issuer: ISSUER });
    await expectInvalidToken(authenticate(`Bearer ${await mint()}`, verify, authOpts));
    expect(getSessionFromBearerTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * A service token: the hub's token for a client acting as itself (`sub` = `client_id`, no user),
 * as an index consumer holds. Read only for a client on the source's service allowlist, as every
 * rating with no region hold; off the list it is refused, as every token without a user was.
 */
describe('🔴 service tokens and the service-client allowlist', () => {
  // A service client id (a random UUID, never a user id), distinct from CLIENT_ID and RELAY_ID.
  const SERVICE_ID = '5b1d3e7a-0c4f-4a92-8e61-2d9f7c3b8a10';
  const serviceToken = (over: Partial<AccessTokenJwtClaims> = {}) =>
    mint({ sub: SERVICE_ID, client_id: SERVICE_ID, scope: 'AppsRead', ...over });
  const allowing = (...ids: string[]) =>
    createHubJwtVerifier(
      { issuer: ISSUER, jwksUri: JWKS_URI, audience: RESOURCE, serviceClients: new Set(ids) },
      { loadUser: getBearerTokenUserMock }
    );
  const verifyVia = (jwt: VerifyToken) =>
    routeVerifyToken({ opaque: vi.fn(async () => null), jwt });
  // Held to SFW by region: a user here reads no mature rating, so a service reading them shows
  // the hold was not applied to it.
  const heldToSfw = { regionRestricted: () => true };

  it('an allowlisted service token reads every rating (r, x, xxx), with no region hold', async () => {
    const exp = nowS() + 600;
    const verified = await allowing(SERVICE_ID)(
      await serviceToken({ exp, act: { sub: RELAY_ID } })
    );
    expect(verified).toEqual({
      subject: `service:${SERVICE_ID}`,
      userId: null,
      clientId: SERVICE_ID,
      scope: TokenScope.AppsRead,
      actor: RELAY_ID,
      service: true,
      expiresAt: new Date(exp * 1000),
    });
    // No user is read for a token that has none.
    expect(getBearerTokenUserMock).not.toHaveBeenCalled();

    const principal = await authenticate(
      `Bearer ${await serviceToken()}`,
      verifyVia(allowing(SERVICE_ID)),
      heldToSfw
    );
    expect(principal.service).toBe(true);
    expect(principal.subject).toBe(`service:${SERVICE_ID}`);
    expect(principal.audience).toEqual({
      key: 'mrx+xxx',
      allowed: { r: true, x: true, xxx: true },
    });
    expect(await principal.recheck!()).toBe('active');
  });

  it('a service token whose client is NOT on the allowlist is invalid_token (fail closed)', async () => {
    // Another client is allowlisted; this one is not.
    const verify = verifyVia(allowing('9d2c4b6a-1e3f-4a5b-9c7d-8e0f1a2b3c4d'));
    await expectInvalidToken(authenticate(`Bearer ${await serviceToken()}`, verify, authOpts));
    expect(getBearerTokenUserMock).not.toHaveBeenCalled();
  });

  it('🔴 a USER token from an allowlisted client is still the user’s audience, region hold and all', async () => {
    // The user may read every mature rating by their own settings.
    getBearerTokenUserMock.mockResolvedValue({ showNsfw: true, browsingLevel: 31 });
    const userToken = await mint({ client_id: SERVICE_ID });
    const verified = await allowing(SERVICE_ID)(userToken);
    expect(verified?.service).toBeUndefined();
    expect(verified?.subject).toBe(`user:${USER_ID}/client:${SERVICE_ID}`);
    // From a region held to SFW, the user reads no mature rating; a service would read all.
    const held = await authenticate(
      `Bearer ${userToken}`,
      verifyVia(allowing(SERVICE_ID)),
      heldToSfw
    );
    expect(held.service).toBeUndefined();
    expect(held.audience).toEqual({ key: 'm', allowed: { r: false, x: false, xxx: false } });
    // And from anywhere else, the user's own settings, not the service audience.
    getBearerTokenUserMock.mockResolvedValue({ showNsfw: true, browsingLevel: 1 | 2 | 4 | 8 });
    const own = await authenticate(
      `Bearer ${userToken}`,
      verifyVia(allowing(SERVICE_ID)),
      authOpts
    );
    expect(own.audience).toEqual({ key: 'mrx', allowed: { r: true, x: true, xxx: false } });
  });

  it('by default (allowlist unset or empty) no service token is accepted, from any client', async () => {
    expect(parseServiceClients(undefined).size).toBe(0);
    expect(parseServiceClients('').size).toBe(0);
    expect(parseServiceClients(' , ').size).toBe(0);
    expect([...parseServiceClients(`${SERVICE_ID}, a-1  b-2`)]).toEqual([SERVICE_ID, 'a-1', 'b-2']);
    for (const verify of [
      createCivitaiTokenVerifier({ resource: RESOURCE, issuer: ISSUER }),
      createCivitaiTokenVerifier({
        resource: RESOURCE,
        issuer: ISSUER,
        serviceClients: parseServiceClients(undefined),
      }),
      hubVerifier(),
    ]) {
      await expectInvalidToken(authenticate(`Bearer ${await serviceToken()}`, verify, authOpts));
    }
    // Control: the same token with its client listed is accepted.
    const listed = createCivitaiTokenVerifier({
      resource: RESOURCE,
      issuer: ISSUER,
      serviceClients: parseServiceClients(SERVICE_ID),
    });
    expect((await authenticate(`Bearer ${await serviceToken()}`, listed, authOpts)).service).toBe(
      true
    );
  });

  it('a service token without AppsRead is refused, listed or not', async () => {
    const verify = allowing(SERVICE_ID);
    expect(await verify(await serviceToken({ scope: 'ModelsRead' }))).toBeNull();
    expect(await verify(await serviceToken({ scope: 'Bogus' }))).toBeNull();
    // Control: the same token with AppsRead (beside another scope) is accepted.
    expect((await verify(await serviceToken({ scope: 'ModelsRead AppsRead' })))?.service).toBe(
      true
    );
  });

  it('a token whose sub is not its client_id and not a user id is refused, listed or not', async () => {
    const verify = allowing(SERVICE_ID);
    expect(await verify(await mint({ sub: 'someone-else', client_id: SERVICE_ID }))).toBeNull();
    expect(await verify(await mint({ sub: SERVICE_ID, client_id: CLIENT_ID }))).toBeNull();
  });
});

describe('🔴 block-exchange tokens: the block binding claims', () => {
  const BLOCK = { appBlockId: 'apb-6f20', blockInstanceId: 'inst-c81d', maxBrowsingLevel: 3 };
  const rawClaims = {
    civitai_token_kind: 'block-exchange',
    civitai_app_block_id: 'apb-6f20',
    civitai_block_instance_id: 'inst-c81d',
    civitai_max_browsing_level: 3,
  };
  const signedWith = (extra: Record<string, unknown>) =>
    signRaw({ typ: 'at+jwt', kid: KID }, { ...claims({ act: { sub: RELAY_ID } }), ...extra });

  it('reads the binding the hub writes as VerifiedToken.block', async () => {
    const verified = await hubVerifier()(
      await mint({ scope: 'AppDataRead', act: { sub: RELAY_ID }, block: BLOCK })
    );
    expect(verified).toMatchObject({
      subject: `user:${USER_ID}/client:${CLIENT_ID}`,
      userId: USER_ID,
      block: { appBlockId: 'apb-6f20', blockInstanceId: 'inst-c81d', maxBrowsingLevel: 3 },
    });
  });

  it('carries the binding through authenticate into the principal token a private stream reads', async () => {
    const principal = await authenticate(
      `Bearer ${await mint({ scope: 'AppDataRead', act: { sub: RELAY_ID }, block: BLOCK })}`,
      hubVerifier(),
      authOpts
    );
    expect(principal.token?.block).toEqual({
      appBlockId: 'apb-6f20',
      blockInstanceId: 'inst-c81d',
      maxBrowsingLevel: 3,
    });
  });

  it('a user-exchange token (none of the claims) has no binding, exactly as before', async () => {
    const verified = await hubVerifier()(await mint({ act: { sub: RELAY_ID } }));
    expect(verified).not.toBeNull();
    expect(verified).not.toHaveProperty('block');
    const principal = await authenticate(`Bearer ${await mint()}`, hubVerifier(), authOpts);
    expect(principal.token).not.toHaveProperty('block');
  });

  it('🔴 a block-exchange token missing any binding claim is refused (fail closed)', async () => {
    // POSITIVE CONTROL: all four, as raw claims, are accepted.
    expect((await hubVerifier()(await signedWith(rawClaims)))?.block).toEqual(BLOCK);
    for (const missing of Object.keys(rawClaims)) {
      const { [missing]: _drop, ...partial } = rawClaims as Record<string, unknown>;
      expect(await hubVerifier()(await signedWith(partial)), missing).toBeNull();
    }
    // The marker alone.
    expect(
      await hubVerifier()(await signedWith({ civitai_token_kind: 'block-exchange' }))
    ).toBeNull();
  });

  it('🔴 a malformed binding is refused: wrong marker, empty ids, a ceiling that is not a non-negative integer', async () => {
    for (const [label, over] of [
      ['another kind', { civitai_token_kind: 'user-exchange' }],
      ['empty block id', { civitai_app_block_id: '' }],
      ['empty install id', { civitai_block_instance_id: '' }],
      ['ceiling as a string', { civitai_max_browsing_level: '31' }],
      ['negative ceiling', { civitai_max_browsing_level: -1 }],
      ['fractional ceiling', { civitai_max_browsing_level: 1.5 }],
    ] as const) {
      expect(await hubVerifier()(await signedWith({ ...rawClaims, ...over })), label).toBeNull();
    }
  });

  it('a service token carrying a binding is refused, even from an allowlisted client', async () => {
    const verify = createHubJwtVerifier(
      {
        issuer: ISSUER,
        jwksUri: JWKS_URI,
        audience: RESOURCE,
        serviceClients: new Set([CLIENT_ID]),
      },
      { loadUser: getBearerTokenUserMock }
    );
    const service = { sub: CLIENT_ID, scope: 'AppsRead' };
    // POSITIVE CONTROL: the same service token without one is accepted.
    expect(await verify(await signedWith(service))).toMatchObject({ service: true });
    expect(await verify(await signedWith({ ...service, ...rawClaims }))).toBeNull();
  });
});
