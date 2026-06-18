import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { importSPKI, jwtVerify, decodeJwt, type CryptoKey } from 'jose';
import { createSessionSigner, type SessionSigner } from '../sign';

// Complements sign.test.ts: focuses on claim-SHAPE edges not covered there — the `aud`-omission
// rule, the per-call expiresIn override, and the jti precedence. A SECOND signer with no
// audience configured exercises the small-token path.
const issuer = 'https://auth.test';
let signer: SessionSigner; // with audience
let noAudSigner: SessionSigner; // audience unset
let publicKeyPem: string;

beforeAll(() => {
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKeyPem = kp.publicKey;
  const base = {
    privateKeyPem: kp.privateKey,
    publicKeyPem: kp.publicKey,
    kid: 'sc-1',
    issuer,
    maxAge: 3600,
  };
  signer = createSessionSigner({ ...base, audience: 'spokes' });
  noAudSigner = createSessionSigner(base); // no audience
});

const pub = () => importSPKI(publicKeyPem, 'ES256') as Promise<CryptoKey>;

describe('createSessionSigner — config validation', () => {
  it('throws without a private key + kid', () => {
    expect(() => createSessionSigner({ kid: 'x' })).toThrow(/AUTH_JWT_PRIVATE_KEY/);
  });
});

describe('mintSessionToken — claim shapes', () => {
  it('sets aud when configured', async () => {
    const token = await signer.mintSessionToken({ user: { id: 1 } });
    expect(decodeJwt(token).aud).toBe('spokes');
  });

  it('OMITS aud when no audience is configured (keeps the cookie small)', async () => {
    const token = await noAudSigner.mintSessionToken({ user: { id: 1 } });
    expect(decodeJwt(token).aud).toBeUndefined();
    // still verifiable when the verifier doesn't require an audience
    const { payload } = await jwtVerify(token, await pub(), { issuer });
    expect(payload.user).toMatchObject({ id: 1 });
  });

  it('honors a per-call expiresIn over the signer maxAge', async () => {
    const token = await signer.mintSessionToken({ user: { id: 1 } }, { expiresIn: 120 });
    const { iat, exp } = decodeJwt(token);
    expect(exp! - iat!).toBeLessThanOrEqual(121);
    expect(exp! - iat!).toBeGreaterThanOrEqual(119);
  });

  it('prefers an explicit jti, else the payload id, else a random uuid', async () => {
    expect(decodeJwt(await signer.mintSessionToken({}, { jti: 'explicit' })).jti).toBe('explicit');
    expect(decodeJwt(await signer.mintSessionToken({ jti: 'from-payload' })).jti).toBe('from-payload');
    const random = decodeJwt(await signer.mintSessionToken({})).jti;
    expect(random).toMatch(/[0-9a-f-]{36}/i); // uuid
  });

  it('always sets a fresh iat/exp and a non-empty iss', async () => {
    const token = await signer.mintSessionToken({ user: { id: 1 } });
    const claims = decodeJwt(token);
    expect(claims.iss).toBe(issuer);
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');
  });
});
