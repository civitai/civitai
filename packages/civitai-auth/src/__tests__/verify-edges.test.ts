import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { generateKeyPairSync, createSecretKey } from 'crypto';
import { hkdfSync } from 'node:crypto';
import { EncryptJWT, SignJWT, UnsecuredJWT } from 'jose';
import { createSessionSigner, type SessionSigner } from '../sign';
import { createAuthVerifier } from '../verify';

// Records the options jose's jwtVerify is called with so the alg-pin tests (B3) can assert ES256 is
// pinned. jose is ESM with frozen exports, so we can't vi.spyOn it — wrap it via vi.mock, delegating
// to the REAL implementation (so signing/verification still work) while capturing each call's opts.
const jwtVerifyCalls: unknown[][] = [];
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    jwtVerify: (...args: Parameters<typeof actual.jwtVerify>) => {
      jwtVerifyCalls.push(args);
      return actual.jwtVerify(...args);
    },
  };
});

// Complements verify.test.ts with edges it doesn't cover: the "no verification key configured" guard
// (verifyToken throws), a valid ES256 token verified against the WRONG public key → null, and
// getSession on an unparseable cookie header.
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

afterEach(() => {
  jwtVerifyCalls.length = 0;
});

describe('createAuthVerifier — ES256 alg pin (B3)', () => {
  it('pins algorithms: ["ES256"] on the asymmetric verify call', async () => {
    // The verifier must never let jose accept an alg other than ES256 on the asymmetric path —
    // the trust root is the EC public key, but the allowlist must be explicit, not inferred from
    // the key type. Assert the option is threaded through.
    const token = await signer.mintSessionToken({ user: { id: 1 } });
    await createAuthVerifier({ issuer, audience, publicKeyPem }).verifyToken(token);
    expect(jwtVerifyCalls.length).toBeGreaterThan(0);
    const opts = jwtVerifyCalls[0][2] as { algorithms?: string[] };
    expect(opts.algorithms).toEqual(['ES256']);
  });
});

describe('createAuthVerifier — alg-confusion rejection, end to end (B3)', () => {
  // Threading the pin through is necessary but not sufficient — these assert a FORGED token is
  // actually rejected, not merely that the option object is shaped right.
  it('rejects an HS256 token signed with the public-key bytes as the HMAC secret', async () => {
    // Classic alg-confusion: attacker treats the PEM the verifier trusts as a symmetric secret.
    // alg=HS256 ≠ ES256, so dispatch sends it to the legacy JWE branch (jwtDecrypt), which rejects
    // it (it isn't a JWE). It can never reach the EC verify path. A legacy secret is present to
    // prove the legacy branch is active and still rejects.
    const hmac = createSecretKey(Buffer.from(publicKeyPem, 'utf8'));
    const forged = await new SignJWT({ user: { id: 99 } })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(hmac);
    const verifier = createAuthVerifier({ issuer, audience, publicKeyPem, legacySecret: LEGACY_SECRET });
    expect(await verifier.verifyToken(forged)).toBeNull();
  });

  it('rejects an alg=none unsecured token', async () => {
    const forged = new UnsecuredJWT({ user: { id: 99 } })
      .setIssuer(issuer)
      .setAudience(audience)
      .encode();
    const verifier = createAuthVerifier({ issuer, audience, publicKeyPem, legacySecret: LEGACY_SECRET });
    expect(await verifier.verifyToken(forged)).toBeNull();
  });
});

// A next-auth-v4-shaped JWE (dir/A256GCM, hkdf key) — the legacy cookie the spoke decodes during the
// cutover. NOTE: it carries NO iss/aud (the real minters in tests/preview-auth.setup.ts and
// tests/lighthouse-mint-cookie.cjs set only { user, sub, id, signedAt } + iat/exp).
const LEGACY_SECRET = 'legacy-secret-0123456789';
const ENC_INFO = 'NextAuth.js Generated Encryption Key';
const legacyKey = () => new Uint8Array(hkdfSync('sha256', LEGACY_SECRET, '', ENC_INFO, 32));
async function mintLegacy() {
  return new EncryptJWT({ user: { id: 7 }, sub: '7', id: 'jti-7', signedAt: 1 })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .encrypt(legacyKey());
}

describe('createAuthVerifier — explicit legacy gate (B3)', () => {
  it('accepts a legacy JWE when legacySecret is present (default: legacy on)', async () => {
    // Preserves migration-window behavior: a configured legacy secret keeps decoding old cookies.
    const verifier = createAuthVerifier({ issuer, audience, publicKeyPem, legacySecret: LEGACY_SECRET });
    const token = await mintLegacy();
    expect(await verifier.verifyToken(token)).toMatchObject({ user: { id: 7 } });
  });

  it('rejects a legacy JWE when legacyEnabled is explicitly false (cutover kill-switch)', async () => {
    // The gate must be flippable independently of secret presence, so a spoke can hard-disable the
    // legacy path at cutover even while NEXTAUTH_SECRET is still in its env.
    const verifier = createAuthVerifier({
      issuer,
      audience,
      publicKeyPem,
      legacySecret: LEGACY_SECRET,
      legacyEnabled: false,
    });
    const token = await mintLegacy();
    expect(await verifier.verifyToken(token)).toBeNull();
  });
});
