import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { createSessionSigner, type SessionSigner } from '../sign';
import { createAuthVerifier } from '../verify';

const issuer = 'https://auth.test';
const audience = 'spokes';
const jwksUri = 'https://auth.test/jwks';
let signer: SessionSigner;
let jwks: { keys: Record<string, unknown>[] };

beforeAll(async () => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
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
  it('verifies an RS256 session token via JWKS', async () => {
    stubJwks();
    const token = await signer.mintSessionToken({ user: { id: 7 }, id: 't7', signedAt: 1 });
    const claims = await createAuthVerifier(cfg).verifyToken(token);
    expect(claims?.user).toMatchObject({ id: 7 });
    expect(claims?.id).toBe('t7');
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
    const verifier = createAuthVerifier({ ...cfg, cookieName: 'civitai-token' });
    const claims = await verifier.getSession({ other: '1', 'civitai-token': token });
    expect(claims?.user).toMatchObject({ id: 7 });
  });

  it('getSession returns null when the cookie is absent', async () => {
    stubJwks();
    const verifier = createAuthVerifier({ ...cfg, cookieName: 'civitai-token' });
    expect(await verifier.getSession('unrelated=1; other=2')).toBeNull();
  });

  it('verifies a swap token and extracts the userId', async () => {
    stubJwks();
    const token = await signer.mintSwapToken(99);
    expect(await createAuthVerifier(cfg).verifySwapToken(token)).toEqual({ userId: 99 });
  });

  it('rejects a session token used as a swap token (purpose mismatch)', async () => {
    stubJwks();
    const token = await signer.mintSessionToken({ user: { id: 7 }, id: 't7' });
    expect(await createAuthVerifier(cfg).verifySwapToken(token)).toBeNull();
  });

  it('getSession reads the token out of a cookie header', async () => {
    stubJwks();
    const token = await signer.mintSessionToken({ user: { id: 7 }, id: 't7' });
    const verifier = createAuthVerifier({ ...cfg, cookieName: 'civitai-token' });
    const claims = await verifier.getSession(`other=1; civitai-token=${token}; x=2`);
    expect(claims?.user).toMatchObject({ id: 7 });
  });

  it('requireAuth returns a login redirect when there is no session', async () => {
    const verifier = createAuthVerifier({ ...cfg, cookieName: 'civitai-token' });
    const result = await verifier.requireAuth('', 'https://moderator.civitai.com/x');
    expect(result).toHaveProperty('redirect');
    if ('redirect' in result) {
      expect(result.redirect).toContain(`${issuer}/login?callbackUrl=`);
    }
  });
});
