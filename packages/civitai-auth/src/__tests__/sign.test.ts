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

describe('private key curve assertion', () => {
  it('accepts a valid EC P-256 key (mints without error)', async () => {
    // The default `signer` is built from a P-256 keypair (see beforeAll); minting must succeed.
    await expect(signer.mintSessionToken({ user: { id: 5 } })).resolves.toEqual(expect.any(String));
  });

  it('rejects an RSA key with a clear, actionable ES256/P-256 error', async () => {
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const rsaSigner = createSessionSigner({
      privateKeyPem: rsa.privateKey,
      publicKeyPem: rsa.publicKey,
      kid: 'rsa-1',
      issuer,
      audience,
      maxAge: 3600,
    });
    // The key is imported lazily on first mint; the assertion must fire there with our message.
    await expect(rsaSigner.mintSessionToken({ user: { id: 5 } })).rejects.toThrow(
      /AUTH_JWT_PRIVATE_KEY must be an EC P-256/
    );
  });

  it('rejects a valid EC key on the WRONG curve (P-384) with the same actionable error', async () => {
    // The classic near-miss: a genuine EC key, but secp384r1 (ES384) instead of P-256. jose binds
    // the curve to the requested alg at import, so this must be rejected — an off-curve key would
    // otherwise mint tokens spokes pinned to ES256 can never verify.
    const ec384 = generateKeyPairSync('ec', {
      namedCurve: 'secp384r1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const signer384 = createSessionSigner({
      privateKeyPem: ec384.privateKey,
      publicKeyPem: ec384.publicKey,
      kid: 'p384-1',
      issuer,
      audience,
      maxAge: 3600,
    });
    await expect(signer384.mintSessionToken({ user: { id: 5 } })).rejects.toThrow(
      /AUTH_JWT_PRIVATE_KEY must be an EC P-256/
    );
  });

  it('rejects an Ed25519 key with the same actionable error', async () => {
    // EdDSA, not ECDSA — must not slip through the EC-name check.
    const ed = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const edSigner = createSessionSigner({
      privateKeyPem: ed.privateKey,
      publicKeyPem: ed.publicKey,
      kid: 'ed-1',
      issuer,
      audience,
      maxAge: 3600,
    });
    await expect(edSigner.mintSessionToken({ user: { id: 5 } })).rejects.toThrow(
      /AUTH_JWT_PRIVATE_KEY must be an EC P-256/
    );
  });
});
