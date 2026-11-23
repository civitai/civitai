import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { createSessionSigner, type AccessTokenJwtClaims, type SessionSigner } from '../sign';
import { createAccessTokenJwtVerifier, createAuthVerifier } from '../verify';

const issuer = 'https://auth.test';
const resource = 'https://registry.test';
const NOW_S = 1_900_000_000;
let signer: SessionSigner;
let publicKeyPem: string;
let privateKeyPem: string;

beforeAll(() => {
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKeyPem = kp.publicKey;
  privateKeyPem = kp.privateKey;
  signer = createSessionSigner({
    privateKeyPem: kp.privateKey,
    publicKeyPem: kp.publicKey,
    kid: 'test-1',
    issuer,
    maxAge: 3600,
  });
});

const claims = (over: Partial<AccessTokenJwtClaims> = {}): AccessTokenJwtClaims => ({
  iss: issuer,
  sub: '42',
  aud: resource,
  client_id: 'app-1',
  scope: 'AIServicesRead AIServicesWrite',
  jti: '6f1c2a8e-7c1b-4f7e-9d55-1a2b3c4d5e6f',
  iat: NOW_S,
  exp: NOW_S + 900,
  ...over,
});

const verifierAt = (nowS: number) =>
  createAccessTokenJwtVerifier({ publicKeyPem, clock: () => nowS * 1000 });

describe('mintAccessTokenJwt', () => {
  it('signs an at+jwt with only the given claims', async () => {
    const token = await signer.mintAccessTokenJwt(claims({ act: { sub: 'relay-1' } }));
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', typ: 'at+jwt', kid: 'test-1' });
    expect(decodeJwt(token)).toEqual({
      iss: issuer,
      sub: '42',
      aud: resource,
      client_id: 'app-1',
      scope: 'AIServicesRead AIServicesWrite',
      jti: '6f1c2a8e-7c1b-4f7e-9d55-1a2b3c4d5e6f',
      iat: NOW_S,
      exp: NOW_S + 900,
      act: { sub: 'relay-1' },
    });
  });

  it('carries aud as a string and omits act on a direct exchange', async () => {
    const payload = decodeJwt(await signer.mintAccessTokenJwt(claims()));
    expect(payload.aud).toBe(resource);
    expect(payload).not.toHaveProperty('act');
    expect(payload).not.toHaveProperty('roles');
    expect(payload).not.toHaveProperty('civitai_uid');
    expect(payload).not.toHaveProperty('civitai_token_kind');
    expect(payload).not.toHaveProperty('civitai_app_block_id');
    expect(payload).not.toHaveProperty('civitai_block_instance_id');
    expect(payload).not.toHaveProperty('civitai_max_browsing_level');
  });

  it('writes a block binding as its four claims, together', async () => {
    const payload = decodeJwt(
      await signer.mintAccessTokenJwt(
        claims({
          block: { appBlockId: 'apb-7d1e', blockInstanceId: 'inst-93c4', maxBrowsingLevel: 3 },
        })
      )
    );
    expect(payload).toMatchObject({
      civitai_token_kind: 'block-exchange',
      civitai_app_block_id: 'apb-7d1e',
      civitai_block_instance_id: 'inst-93c4',
      civitai_max_browsing_level: 3,
    });
    expect(payload).not.toHaveProperty('block');
  });

  it('carries roles and civitai_uid only when given', async () => {
    const payload = decodeJwt(
      await signer.mintAccessTokenJwt(claims({ roles: ['trusted', 'Manager'], civitai_uid: -1001 }))
    );
    expect(payload).toMatchObject({ roles: ['trusted', 'Manager'], civitai_uid: -1001 });
  });

  it('refuses an empty issuer or audience', async () => {
    await expect(signer.mintAccessTokenJwt(claims({ iss: '' }))).rejects.toThrow(/issuer/);
    await expect(signer.mintAccessTokenJwt(claims({ aud: '' }))).rejects.toThrow(/audience/);
    // Control: the same claims with both set sign.
    await expect(signer.mintAccessTokenJwt(claims())).resolves.toMatch(/^ey/);
  });
});

describe('createAccessTokenJwtVerifier', () => {
  it('accepts a live at+jwt from the hub key', async () => {
    const token = await signer.mintAccessTokenJwt(claims());
    expect(await verifierAt(NOW_S + 10)(token, issuer)).toMatchObject({ sub: '42', aud: resource });
  });

  it('gives exp no leeway', async () => {
    const token = await signer.mintAccessTokenJwt(claims());
    expect(await verifierAt(NOW_S + 900)(token, issuer)).toBeNull();
    expect(await verifierAt(NOW_S + 899)(token, issuer)).not.toBeNull();
  });

  it('allows iat up to 30 seconds ahead, and no more', async () => {
    const ahead31 = await signer.mintAccessTokenJwt(claims({ iat: NOW_S + 31 }));
    const ahead30 = await signer.mintAccessTokenJwt(claims({ iat: NOW_S + 30 }));
    expect(await verifierAt(NOW_S)(ahead31, issuer)).toBeNull();
    expect(await verifierAt(NOW_S)(ahead30, issuer)).not.toBeNull();
  });

  it('refuses another issuer', async () => {
    const token = await signer.mintAccessTokenJwt(claims());
    expect(await verifierAt(NOW_S)(token, 'https://other.test')).toBeNull();
    expect(await verifierAt(NOW_S)(token, issuer)).not.toBeNull();
  });

  it('refuses an empty issuer instead of skipping the check', async () => {
    const token = await signer.mintAccessTokenJwt(claims());
    await expect(verifierAt(NOW_S)(token, '')).rejects.toThrow(/issuer/);
  });

  it('throws, on every call, when no public key is configured or it cannot be imported', async () => {
    const token = await signer.mintAccessTokenJwt(claims());
    const unconfigured = createAccessTokenJwtVerifier({
      publicKeyPem: '',
      clock: () => NOW_S * 1000,
    });
    await expect(unconfigured(token, issuer)).rejects.toThrow(/no AUTH_JWT_PUBLIC_KEY configured/);
    await expect(unconfigured(token, issuer)).rejects.toThrow(/no AUTH_JWT_PUBLIC_KEY configured/);
    const garbled = createAccessTokenJwtVerifier({
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nbm90IGEga2V5\n-----END PUBLIC KEY-----',
      clock: () => NOW_S * 1000,
    });
    await expect(garbled(token, issuer)).rejects.toThrow();
    // The failed import is cached, and still throws rather than reading as a bad token.
    await expect(garbled(token, issuer)).rejects.toThrow();
    // Control: the same token against the configured key verifies.
    expect(await verifierAt(NOW_S)(token, issuer)).not.toBeNull();
  });

  it('refuses a session token (typ JWT) signed by the same key', async () => {
    const session = await signer.mintSessionToken({ user: { id: 42 } }, { expiresIn: 3600 });
    const verify = createAccessTokenJwtVerifier({ publicKeyPem });
    expect(await verify(session, issuer)).toBeNull();
    // Control: an at+jwt from the same signer passes the same verifier.
    const now = Math.floor(Date.now() / 1000);
    const at = await signer.mintAccessTokenJwt(claims({ iat: now, exp: now + 60 }));
    expect(await verify(at, issuer)).not.toBeNull();
  });

  it('refuses a token whose signature does not match', async () => {
    const token = await signer.mintAccessTokenJwt(claims());
    const [h, p, sig] = token.split('.');
    const flipped = `${h}.${p}.${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`;
    expect(await verifierAt(NOW_S)(flipped, issuer)).toBeNull();
  });
});

describe('createAccessTokenJwtVerifier with an audience and a JWKS', () => {
  const JWKS_URI = 'https://auth.test/.well-known/jwks.json';
  const liveClaims = (over: Partial<AccessTokenJwtClaims> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return claims({ iat: now, exp: now + 600, ...over });
  };
  const serve = (res: () => Response) => {
    const fetchMock = vi.fn<typeof fetch>(async () => res());
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  afterEach(() => vi.unstubAllGlobals());

  it('refuses a token for another audience, and accepts its own', async () => {
    const verify = createAccessTokenJwtVerifier({ publicKeyPem, audience: resource });
    expect(
      await verify(await signer.mintAccessTokenJwt(liveClaims({ aud: 'https://x.test' })), issuer)
    ).toBeNull();
    expect(await verify(await signer.mintAccessTokenJwt(liveClaims()), issuer)).not.toBeNull();
  });

  it('verifies against the JWKS at jwksUri', async () => {
    const jwks = await signer.publicJwks();
    const fetchMock = serve(() => new Response(JSON.stringify(jwks), { status: 200 }));
    const verify = createAccessTokenJwtVerifier({ jwksUri: JWKS_URI, audience: resource });
    expect(await verify(await signer.mintAccessTokenJwt(liveClaims()), issuer)).toMatchObject({
      sub: '42',
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(JWKS_URI);
  });

  it('throws when the JWKS cannot be read, instead of refusing the token', async () => {
    serve(() => new Response('down', { status: 503 }));
    const verify = createAccessTokenJwtVerifier({ jwksUri: JWKS_URI, audience: resource });
    await expect(verify(await signer.mintAccessTokenJwt(liveClaims()), issuer)).rejects.toThrow(
      /200 OK/
    );
  });

  it('throws when the JWKS fetch itself fails (a network error with no code)', async () => {
    const netErr = new TypeError('fetch failed');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        throw netErr;
      })
    );
    const verify = createAccessTokenJwtVerifier({ jwksUri: JWKS_URI, audience: resource });
    await expect(verify(await signer.mintAccessTokenJwt(liveClaims()), issuer)).rejects.toBe(
      netErr
    );
  });

  it('throws when the JWKS response is not a key set (ERR_JWKS_INVALID)', async () => {
    serve(() => new Response(JSON.stringify({ keys: 'not-a-list' }), { status: 200 }));
    const verify = createAccessTokenJwtVerifier({ jwksUri: JWKS_URI, audience: resource });
    await expect(
      verify(await signer.mintAccessTokenJwt(liveClaims()), issuer)
    ).rejects.toMatchObject({ code: 'ERR_JWKS_INVALID' });
  });

  it('throws when the JWKS fetch times out (ERR_JWKS_TIMEOUT)', async () => {
    // jose aborts the fetch with AbortSignal.timeout; a fetch so aborted rejects with a
    // TimeoutError, which is what this one does at once, so no real time passes.
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);
    const verify = createAccessTokenJwtVerifier({ jwksUri: JWKS_URI, audience: resource });
    await expect(
      verify(await signer.mintAccessTokenJwt(liveClaims()), issuer)
    ).rejects.toMatchObject({ code: 'ERR_JWKS_TIMEOUT' });
    // The fetch was given an abort signal, the timeout this stands in for.
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('session verifier and at+jwt', () => {
  const liveClaims = () => {
    const now = Math.floor(Date.now() / 1000);
    return claims({ iat: now, exp: now + 600 });
  };

  it('refuses an at+jwt as a session', async () => {
    const verifier = createAuthVerifier({ publicKeyPem, issuer });
    expect(await verifier.verifyToken(await signer.mintAccessTokenJwt(liveClaims()))).toBeNull();
    // Control: a real session token from the same signer verifies.
    const session = await signer.mintSessionToken({ user: { id: 42 } }, { expiresIn: 3600 });
    expect(await verifier.verifyToken(session)).toMatchObject({ user: { id: 42 } });
  });

  it('refuses an at+jwt even when the verifier is configured with its audience', async () => {
    // With `audience` set, the aud-means-not-a-session rule is off, so only the typ check stands.
    const verifier = createAuthVerifier({ publicKeyPem, issuer, audience: resource });
    expect(await verifier.verifyToken(await signer.mintAccessTokenJwt(liveClaims()))).toBeNull();
    // Control: a session token minted for that audience verifies under the same verifier.
    const audSigner = createSessionSigner({
      privateKeyPem,
      kid: 'test-1',
      issuer,
      audience: resource,
    });
    const session = await audSigner.mintSessionToken({ user: { id: 42 } }, { expiresIn: 3600 });
    expect(await verifier.verifyToken(session)).toMatchObject({ user: { id: 42 } });
  });
});
