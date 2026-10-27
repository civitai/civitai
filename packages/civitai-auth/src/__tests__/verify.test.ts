import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { createSessionSigner, type SessionSigner } from '../sign';
import { createAuthVerifier } from '../verify';

const issuer = 'https://auth.test';
const audience = 'spokes';
const jwksUri = 'https://auth.test/jwks';
let signer: SessionSigner;
let jwks: { keys: Record<string, unknown>[] };
let publicKeyPem: string;

beforeAll(async () => {
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256', // ES256
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKeyPem = kp.publicKey;
  signer = createSessionSigner({
    privateKeyPem: kp.privateKey,
    publicKeyPem: kp.publicKey,
    kid: 'v-1',
    issuer,
    audience,
    maxAge: 3600,
  });
  jwks = await signer.publicJwks();
});

afterEach(() => vi.unstubAllGlobals());

// Stub global fetch so jose's createRemoteJWKSet resolves our in-memory key set.
function stubJwks() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(jwks), { headers: { 'content-type': 'application/json' } })
    )
  );
}

const cfg = { jwksUri, issuer, audience };

describe('createAuthVerifier', () => {
  it('verifies an ES256 session token via JWKS', async () => {
    stubJwks();
    const token = await signer.mintSessionToken({ user: { id: 7 }, signedAt: 1 }, { jti: 't7' });
    const claims = await createAuthVerifier(cfg).verifyToken(token);
    expect(claims?.user).toMatchObject({ id: 7 });
    expect(claims?.jti).toBe('t7');
  });

  it('reports the JWKS leg outcome "hit" on a successful JWKS verify (SPOF-fix instrumentation)', async () => {
    stubJwks();
    const onJwksLeg = vi.fn<(o: 'hit' | 'timeout', s: number) => void>();
    const token = await signer.mintSessionToken({ user: { id: 7 }, signedAt: 1 }, { jti: 't7' });
    await createAuthVerifier({ ...cfg, onJwksLeg }).verifyToken(token);
    expect(onJwksLeg).toHaveBeenCalledWith('hit', expect.any(Number));
  });

  it('still verifies when a throwing onJwksLeg callback fires (instrumentation is best-effort)', async () => {
    stubJwks();
    const token = await signer.mintSessionToken({ user: { id: 7 }, signedAt: 1 }, { jti: 't7' });
    const onJwksLeg = vi.fn(() => {
      throw new Error('metrics exploded');
    });
    // Without safeInvoke this would re-throw → verifyToken returns null → a valid token becomes a logout.
    const claims = await createAuthVerifier({ ...cfg, onJwksLeg }).verifyToken(token);
    expect(claims?.user).toMatchObject({ id: 7 }); // verify SUCCEEDS despite the throwing callback
    expect(onJwksLeg).toHaveBeenCalled();
  });

  it('does NOT fire the JWKS leg on the LOCAL public-key (hub) path — no network to instrument', async () => {
    const onJwksLeg = vi.fn<(o: 'hit' | 'timeout', s: number) => void>();
    const token = await signer.mintSessionToken({ user: { id: 7 }, signedAt: 1 }, { jti: 't7' });
    await createAuthVerifier({ issuer, audience, publicKeyPem, onJwksLeg }).verifyToken(token);
    expect(onJwksLeg).not.toHaveBeenCalled();
  });

  it('does NOT report a JWKS timeout on an ordinary bad-token verify failure', async () => {
    stubJwks();
    const onJwksLeg = vi.fn<(o: 'hit' | 'timeout', s: number) => void>();
    // Wrong issuer → jwtVerify throws a claim-validation error (NOT a timeout) → verifyToken returns null,
    // and the JWKS leg must not be recorded as a timeout.
    const token = await signer.mintSessionToken({ user: { id: 7 }, signedAt: 1 }, { jti: 't7' });
    const claims = await createAuthVerifier({
      jwksUri,
      issuer: 'https://nope.test',
      audience,
      onJwksLeg,
    }).verifyToken(token);
    expect(claims).toBeNull();
    expect(onJwksLeg).not.toHaveBeenCalledWith('timeout', expect.any(Number));
  });

  it('verifies an ES256 token with a LOCAL public key (no JWKS fetch)', async () => {
    // No stubJwks() here: a local public key must verify WITHOUT any network. If it fell through to
    // JWKS, global fetch is unstubbed and this would reject.
    const token = await signer.mintSessionToken({ user: { id: 7 }, signedAt: 1 }, { jti: 't7' });
    const verifier = createAuthVerifier({ issuer, audience, publicKeyPem });
    const claims = await verifier.verifyToken(token);
    expect(claims?.user).toMatchObject({ id: 7 });
    expect(claims?.jti).toBe('t7');
  });

  it('local-key verifier still rejects a wrong-issuer token', async () => {
    const token = await signer.mintSessionToken({ user: { id: 7 }, id: 't7' });
    const verifier = createAuthVerifier({ issuer: 'https://nope.test', audience, publicKeyPem });
    expect(await verifier.verifyToken(token)).toBeNull();
  });

  it('returns null when isRevoked says so', async () => {
    stubJwks();
    const token = await signer.mintSessionToken({ user: { id: 7 }, id: 't7', signedAt: 1 });
    const verifier = createAuthVerifier({ ...cfg, isRevoked: async () => true });
    expect(await verifier.verifyToken(token)).toBeNull();
  });

  it('rejects a token with the wrong audience', async () => {
    stubJwks();
    const token = await signer.mintSessionToken({ user: { id: 7 }, id: 't7' });
    const verifier = createAuthVerifier({ ...cfg, audience: 'someone-else' });
    expect(await verifier.verifyToken(token)).toBeNull();
  });

  it('rejects a garbage token', async () => {
    stubJwks();
    expect(await createAuthVerifier(cfg).verifyToken('not.a.jwt')).toBeNull();
  });

  it('rejects an expired RS256 token', async () => {
    stubJwks();
    // expiresIn in the past → exp already elapsed.
    const token = await signer.mintSessionToken({ user: { id: 7 }, id: 't7' }, { expiresIn: -10 });
    expect(await createAuthVerifier(cfg).verifyToken(token)).toBeNull();
  });

  it('rejects a token minted by the right key but for a different issuer', async () => {
    stubJwks();
    const token = await signer.mintSessionToken({ user: { id: 7 }, id: 't7' });
    const verifier = createAuthVerifier({ ...cfg, issuer: 'https://someone-else.test' });
    expect(await verifier.verifyToken(token)).toBeNull();
  });

  it('returns null (not throw) on a corrupt legacy token in the JWE branch', async () => {
    // No JWKS configured + legacySecret set → a non-RS256/garbage token falls to the legacy
    // next-auth decode, which throws on corrupt input. verifyToken must swallow that → null.
    const verifier = createAuthVerifier({ issuer, audience, legacySecret: 'legacy-secret' });
    await expect(verifier.verifyToken('not.a.jwt')).resolves.toBeNull();
  });

  it('getSession reads the token out of a parsed cookie map', async () => {
    stubJwks();
    const token = await signer.mintSessionToken({ user: { id: 7 }, id: 't7' });
    const verifier = createAuthVerifier({ ...cfg, cookieName: 'civ-token' });
    const claims = await verifier.getSession({ other: '1', 'civ-token': token });
    expect(claims?.user).toMatchObject({ id: 7 });
  });

  it('getSession returns null when the cookie is absent', async () => {
    stubJwks();
    const verifier = createAuthVerifier({ ...cfg, cookieName: 'civ-token' });
    expect(await verifier.getSession('unrelated=1; other=2')).toBeNull();
  });

  it('getSession reads the token out of a cookie header', async () => {
    stubJwks();
    const token = await signer.mintSessionToken({ user: { id: 7 }, id: 't7' });
    const verifier = createAuthVerifier({ ...cfg, cookieName: 'civ-token' });
    const claims = await verifier.getSession(`other=1; civ-token=${token}; x=2`);
    expect(claims?.user).toMatchObject({ id: 7 });
  });

  it('requireAuth returns a login redirect when there is no session', async () => {
    const verifier = createAuthVerifier({ ...cfg, cookieName: 'civ-token' });
    const result = await verifier.requireAuth('', 'https://moderator.civitai.com/x');
    expect(result).toHaveProperty('redirect');
    if ('redirect' in result) {
      expect(result.redirect).toContain(`${issuer}/login?callbackUrl=`);
    }
  });

  describe('without a configured audience', () => {
    let hubSigner: SessionSigner;
    let hubPublicKeyPem: string;
    beforeAll(() => {
      const kp = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      hubPublicKeyPem = kp.publicKey;
      hubSigner = createSessionSigner({ privateKeyPem: kp.privateKey, kid: 'h-1', issuer });
    });

    it('accepts a session token', async () => {
      const token = await hubSigner.mintSessionToken({ sub: '42', signedAt: 1 }, { jti: 's42' });
      const verifier = createAuthVerifier({ issuer, publicKeyPem: hubPublicKeyPem });
      const claims = await verifier.verifyToken(token);
      expect(claims?.sub).toBe('42');
    });

    it('rejects a token that carries an audience', async () => {
      const token = await hubSigner.mintIdToken({ sub: 42, aud: 'some-client', nonce: 'n' });
      const verifier = createAuthVerifier({ issuer, publicKeyPem: hubPublicKeyPem });
      const claims = await verifier.verifyToken(token);
      expect(claims?.sub ?? null).toBeNull();
    });
  });
});

describe('createAuthVerifier — 90-day sign-in limit', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = Date.UTC(2026, 9, 1);
  const verifierAt = (t: number, over: Parameters<typeof createAuthVerifier>[0] = {}) =>
    createAuthVerifier({ publicKeyPem, issuer, audience, clock: () => t, ...over });
  const mint = (claims: Record<string, unknown>) =>
    signer.mintSessionToken({ sub: '7', signedAt: T0, ...claims }, { jti: 'j' });

  it('verifier rejects past iat0+90d', async () => {
    const token = await mint({ iat0: T0 });
    expect(await verifierAt(T0 + 90 * DAY - 1).verifyToken(token)).not.toBeNull();
    expect(await verifierAt(T0 + 90 * DAY).verifyToken(token)).toBeNull();
  });

  it('rejects an impersonation token past impExp', async () => {
    const token = await mint({ iat0: T0, impersonatedBy: 100, impExp: T0 + 4 * 60 * 60 * 1000 });
    expect(await verifierAt(T0 + 60 * 1000).verifyToken(token)).not.toBeNull();
    expect(await verifierAt(T0 + 4 * 60 * 60 * 1000).verifyToken(token)).toBeNull();
  });

  it('accepts a token without iat0 unless required', async () => {
    const token = await mint({});
    expect(await verifierAt(T0 + 365 * DAY).verifyToken(token)).not.toBeNull();
    expect(await verifierAt(T0, { requireIat0: true }).verifyToken(token)).toBeNull();
  });

  it('requires iat0 only when AUTH_REQUIRE_IAT0 is set', async () => {
    const token = await mint({});
    vi.resetModules();
    vi.stubEnv('AUTH_REQUIRE_IAT0', 'true');
    try {
      const { createAuthVerifier: fresh } = await import('../verify');
      expect(await fresh({ publicKeyPem, issuer, audience }).verifyToken(token)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
