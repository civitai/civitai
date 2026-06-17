import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { createSessionSigner, type SessionSigner } from '../sign';
import { createAuthVerifier } from '../verify';

// Complements verify.test.ts with edges it doesn't cover: the "no verification key configured"
// guards (verifyToken + verifySwapToken both throw), a valid ES256 token verified against the WRONG
// public key → null, swap-token issuer/audience mismatch → null, and getSession on an unparseable
// cookie header.
const issuer = 'https://auth.test';
const audience = 'spokes';
let signer: SessionSigner;
let publicKeyPem: string;
let otherPublicKeyPem: string;

beforeAll(() => {
  const mk = () =>
    generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  const kp = mk();
  const other = mk();
  publicKeyPem = kp.publicKey;
  otherPublicKeyPem = other.publicKey; // unrelated keypair
  signer = createSessionSigner({
    privateKeyPem: kp.privateKey,
    publicKeyPem: kp.publicKey,
    kid: 've-1',
    issuer,
    audience,
    maxAge: 3600,
  });
});

describe('createAuthVerifier — no key configured', () => {
  it('verifyToken throws on an ES256 token when neither public key nor JWKS is set', async () => {
    const token = await signer.mintSessionToken({ user: { id: 1 } });
    const verifier = createAuthVerifier({ issuer, audience }); // no publicKeyPem, no jwksUri
    await expect(verifier.verifyToken(token)).rejects.toThrow(/no AUTH_JWT_PUBLIC_KEY or AUTH_JWKS_URI/);
  });

  it('verifySwapToken throws when neither public key nor JWKS is set', async () => {
    const verifier = createAuthVerifier({ issuer, audience });
    await expect(verifier.verifySwapToken('any.token.here')).rejects.toThrow(
      /no AUTH_JWT_PUBLIC_KEY or AUTH_JWKS_URI/
    );
  });
});

describe('createAuthVerifier — wrong key / mismatched claims', () => {
  it('returns null for a valid token verified against an UNRELATED public key', async () => {
    const token = await signer.mintSessionToken({ user: { id: 1 } });
    const verifier = createAuthVerifier({ issuer, audience, publicKeyPem: otherPublicKeyPem });
    expect(await verifier.verifyToken(token)).toBeNull();
  });

  it('returns null (not throw) for a non-JWT string in the ES256 branch with a local key', async () => {
    const verifier = createAuthVerifier({ issuer, audience, publicKeyPem });
    expect(await verifier.verifyToken('garbage')).toBeNull();
  });

  it('verifySwapToken rejects a swap token whose issuer does not match', async () => {
    const token = await signer.mintSwapToken(7);
    const verifier = createAuthVerifier({ issuer: 'https://other.test', audience, publicKeyPem });
    expect(await verifier.verifySwapToken(token)).toBeNull();
  });

  it('verifySwapToken rejects a swap token whose audience does not match', async () => {
    const token = await signer.mintSwapToken(7);
    const verifier = createAuthVerifier({ issuer, audience: 'someone-else', publicKeyPem });
    expect(await verifier.verifySwapToken(token)).toBeNull();
  });

  it('verifySwapToken extracts the userId on a fully-matching swap token', async () => {
    const token = await signer.mintSwapToken(7);
    const verifier = createAuthVerifier({ issuer, audience, publicKeyPem });
    // verifySwapToken returns the single-use jti alongside the userId.
    const result = await verifier.verifySwapToken(token);
    expect(result).toMatchObject({ userId: 7 });
    expect(typeof result?.jti).toBe('string');
  });
});

describe('createAuthVerifier — cookie extraction edges', () => {
  it('getSession returns null when the cookie header has no matching name', async () => {
    const verifier = createAuthVerifier({ issuer, audience, publicKeyPem, cookieName: 'civ-token' });
    expect(await verifier.getSession('foo=1; bar=2')).toBeNull();
  });

  it('getSession tolerates malformed cookie segments (no `=`)', async () => {
    const verifier = createAuthVerifier({ issuer, audience, publicKeyPem, cookieName: 'civ-token' });
    expect(await verifier.getSession('justaflag; another')).toBeNull();
  });
});
