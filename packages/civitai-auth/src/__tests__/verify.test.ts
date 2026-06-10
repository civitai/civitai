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
