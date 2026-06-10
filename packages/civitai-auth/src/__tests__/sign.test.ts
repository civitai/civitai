import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { importSPKI, jwtVerify, decodeProtectedHeader, type CryptoKey } from 'jose';
import { createSessionSigner, type SessionSigner } from '../sign';

const issuer = 'https://auth.test';
const audience = 'spokes';
let signer: SessionSigner;
let publicKeyPem: string;

beforeAll(() => {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
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

const pub = () => importSPKI(publicKeyPem, 'RS256') as Promise<CryptoKey>;

describe('mintSessionToken', () => {
  it('signs an RS256 session JWT verifiable by the public key', async () => {
    const token = await signer.mintSessionToken(
      { user: { id: 5, username: 'bob' }, id: 'tok-1', signedAt: 123 },
      { jti: 'tok-1' }
    );
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'RS256', kid: 'test-1' });

    const { payload } = await jwtVerify(token, await pub(), { issuer, audience });
    expect(payload.user).toMatchObject({ id: 5, username: 'bob' });
    expect(payload.id).toBe('tok-1'); // the claim createSessionRegistry/isRevoked reads
    expect(payload.jti).toBe('tok-1');
    expect(payload.signedAt).toBe(123);
    expect(payload.iss).toBe(issuer);
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
    expect(jwks.keys[0]).toMatchObject({ kid: 'test-1', use: 'sig', alg: 'RS256', kty: 'RSA' });
  });
});
