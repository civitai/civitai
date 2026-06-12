import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { importSPKI, jwtVerify, decodeProtectedHeader, type CryptoKey } from 'jose';
import { createSessionSigner, type SessionSigner } from '../sign';

const issuer = 'https://auth.test';
const audience = 'spokes';
let signer: SessionSigner;
let publicKeyPem: string;

beforeAll(() => {
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256', // ES256
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKeyPem = kp.publicKey;
  signer = createSessionSigner({
    privateKeyPem: kp.privateKey,
    publicKeyPem: kp.publicKey,
    kid: 'test-1',
    issuer,
    audience,
    maxAge: 3600,
  });
});

const pub = () => importSPKI(publicKeyPem, 'ES256') as Promise<CryptoKey>;

describe('mintSessionToken', () => {
  it('signs an ES256 session JWT verifiable by the public key', async () => {
    const token = await signer.mintSessionToken(
      { user: { id: 5, username: 'bob' }, signedAt: 123 },
      { jti: 'tok-1' }
    );
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid: 'test-1' });

    const { payload } = await jwtVerify(token, await pub(), { issuer, audience });
    expect(payload.user).toMatchObject({ id: 5, username: 'bob' });
    expect(payload.jti).toBe('tok-1'); // the session id — the claim createSessionRegistry/isRevoked reads
    expect(payload.id).toBeUndefined(); // no duplicate `id`
    expect(payload.signedAt).toBe(123);
    expect(payload.iss).toBe(issuer);
  });

  it('ignores caller-supplied reserved claims (cannot forge exp)', async () => {
    const forgedExp = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600; // +10y
    const token = await signer.mintSessionToken({ user: { id: 5 }, id: 't', exp: forgedExp });
    const { payload } = await jwtVerify(token, await pub(), { issuer, audience });
    // The signer sets exp from maxAge (3600s), not the value passed in the payload.
    expect(payload.exp).not.toBe(forgedExp);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(3601);
  });
});

describe('mintIdToken', () => {
  it('signs an OIDC id_token with aud + nonce', async () => {
    const token = await signer.mintIdToken({ sub: 5, aud: 'client-x', nonce: 'n0nce' });
    const { payload } = await jwtVerify(token, await pub(), { issuer, audience: 'client-x' });
    expect(payload.sub).toBe('5');
    expect(payload.nonce).toBe('n0nce');
    expect(payload.iss).toBe(issuer);
  });

  it('echoes auth_time and profile claims, and omits nonce when not given', async () => {
    const token = await signer.mintIdToken({
      sub: 9,
      aud: 'client-y',
      authTime: 1700000000,
      claims: { email: 'a@b.com', email_verified: true },
    });
    const { payload } = await jwtVerify(token, await pub(), { issuer, audience: 'client-y' });
    expect(payload.auth_time).toBe(1700000000);
    expect(payload.email).toBe('a@b.com');
    expect(payload.email_verified).toBe(true);
    expect(payload.nonce).toBeUndefined();
  });
});

describe('mintSwapToken', () => {
  it('signs a short-lived swap token with purpose=swap', async () => {
    const token = await signer.mintSwapToken(42);
    const { payload } = await jwtVerify(token, await pub(), { issuer, audience });
    expect(payload.purpose).toBe('swap');
    expect(payload.sub).toBe('42');
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(61); // ~60s
  });
});

describe('publicJwks', () => {
  it('exports a JWK with kid/use/alg', async () => {
    const jwks = await signer.publicJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kid: 'test-1', use: 'sig', alg: 'ES256', kty: 'EC' });
  });
});
