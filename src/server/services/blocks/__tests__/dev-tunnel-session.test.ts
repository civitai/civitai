import { describe, expect, it } from 'vitest';
import {
  DEV_HOST_LABEL_REGEX,
  devHostRegexForDomain,
  fingerprintSshPublicKey,
  generateDevHostLabel,
  isValidDevHost,
  normalizeSshPublicKey,
  pubKeysMatch,
  sharedSecretMatch,
  signDevTunnelAccessToken,
  verifyDevTunnelAccessToken,
} from '~/server/services/blocks/dev-tunnel-session';

/**
 * APP DEV TUNNEL — pure-crypto coverage for the entry token (author-bound) + the
 * sish tunnel-credential pubkey helpers.
 */

const SECRET = 'test-nextauth-secret-aaaaaaaaaaaaaaaaaaaa';
const HOST = 'dev-0123456789abcdef.civit.ai';
const USER = 4242;
const PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBytesHere0123456789abc dev@laptop';

describe('signDevTunnelAccessToken / verifyDevTunnelAccessToken (entry token)', () => {
  it('roundtrips: a fresh token verifies for the bound host + returns the author userId', () => {
    const token = signDevTunnelAccessToken({ userId: USER, host: HOST, secret: SECRET });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyDevTunnelAccessToken(token, HOST, { secret: SECRET })).toEqual({
      ok: true,
      userId: USER,
    });
  });

  it('rejects a token verified against a DIFFERENT host (host binding, T6/T3)', () => {
    const token = signDevTunnelAccessToken({ userId: USER, host: HOST, secret: SECRET });
    expect(
      verifyDevTunnelAccessToken(token, 'dev-deadbeefdeadbeef.civit.ai', { secret: SECRET })
    ).toEqual({ ok: false });
  });

  it('rejects a token signed with a different secret (sig mismatch, constant-time path)', () => {
    const token = signDevTunnelAccessToken({ userId: USER, host: HOST, secret: 'other-secret-xx' });
    expect(verifyDevTunnelAccessToken(token, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it('rejects an expired token (exp in the past)', () => {
    const token = signDevTunnelAccessToken({
      userId: USER,
      host: HOST,
      secret: SECRET,
      ttlSeconds: -1,
    });
    expect(verifyDevTunnelAccessToken(token, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it('rejects a tampered payload (different userId) — recomputed signing string diverges', () => {
    const token = signDevTunnelAccessToken({ userId: USER, host: HOST, secret: SECRET });
    const [payloadB64, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    payload.u = 9999; // escalate to another user
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect(verifyDevTunnelAccessToken(forged, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it('NEVER throws on malformed input → { ok:false }', () => {
    for (const bad of [null, undefined, '', 'nodot', '.', 'a.', '.b', '💥.💥', 'x'.repeat(5000)]) {
      expect(verifyDevTunnelAccessToken(bad as never, HOST, { secret: SECRET })).toEqual({
        ok: false,
      });
    }
  });

  it('is domain-separated from the review-sandbox mr token (cannot be cross-verified)', () => {
    // A review token over the SAME secret must NOT verify as a dev token, and
    // vice versa — the domain prefixes differ.
    const dev = signDevTunnelAccessToken({ userId: USER, host: HOST, secret: SECRET });
    // Hand-craft a review-shaped payload {m,h,exp} and confirm the dev verifier
    // rejects it (different field names + signing string).
    const reviewPayload = Buffer.from(JSON.stringify({ m: USER, h: HOST, exp: 9e9 })).toString(
      'base64url'
    );
    expect(verifyDevTunnelAccessToken(`${reviewPayload}.${dev.split('.')[1]}`, HOST, { secret: SECRET })).toEqual({
      ok: false,
    });
  });
});

describe('dev host generation + validation (T6 SSRF surface)', () => {
  it('generateDevHostLabel yields dev-<16hex>', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateDevHostLabel()).toMatch(DEV_HOST_LABEL_REGEX);
    }
  });

  it('isValidDevHost accepts a well-formed host and rejects everything else', () => {
    expect(isValidDevHost('dev-0123456789abcdef.civit.ai', 'civit.ai')).toBe(true);
    // rejects: wrong prefix, wrong length, uppercase hex, wrong domain, path/query
    // injection, a deployed <slug>.civit.ai bundle host, review host.
    for (const bad of [
      'review-0123456789abcdef.civit.ai',
      'dev-0123456789abcde.civit.ai', // 15 hex
      'dev-0123456789ABCDEF.civit.ai', // uppercase
      'dev-0123456789abcdef.evil.com',
      'dev-0123456789abcdef.civit.ai.evil.com',
      'myapp.civit.ai',
      'dev-0123456789abcdef.civit.ai/../../etc',
      'dev-0123456789abcdef.civit.ai?x=1',
      '',
      null,
      undefined,
    ]) {
      expect(isValidDevHost(bad as never, 'civit.ai')).toBe(false);
    }
  });

  it('devHostRegexForDomain escapes the domain dots (no wildcard match)', () => {
    const re = devHostRegexForDomain('civit.ai');
    expect(re.test('dev-0123456789abcdef.civitXai')).toBe(false); // '.' is literal
  });
});

describe('SSH pubkey credential helpers (sish authz core)', () => {
  it('normalizeSshPublicKey drops the comment but keeps type+key stable', () => {
    const a = normalizeSshPublicKey('ssh-ed25519 AAAAC3Nza dev@laptop');
    const b = normalizeSshPublicKey('  ssh-ed25519   AAAAC3Nza   other@host  ');
    expect(a).toBe('ssh-ed25519 AAAAC3Nza');
    expect(a).toBe(b); // comment/whitespace-insensitive → a reconnect matches
  });

  it('normalizeSshPublicKey rejects junk', () => {
    for (const bad of ['', 'notakey', 'ssh-ed25519', null, undefined]) {
      expect(normalizeSshPublicKey(bad as never)).toBe('');
    }
  });

  it('fingerprint is stable across comment changes + null on junk', () => {
    const f1 = fingerprintSshPublicKey('ssh-ed25519 AAAAC3Nza a@x');
    const f2 = fingerprintSshPublicKey('ssh-ed25519 AAAAC3Nza b@y');
    expect(f1).toBe(f2);
    expect(f1).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintSshPublicKey('junk')).toBeNull();
  });

  it('pubKeysMatch: constant-time equality on normalized keys', () => {
    expect(pubKeysMatch(PUBKEY, `${PUBKEY} different-comment`)).toBe(true);
    expect(pubKeysMatch(PUBKEY, 'ssh-ed25519 DIFFERENTKEYBYTES x@y')).toBe(false);
    // WRONG-PUBKEY (the sish authz deny case) + malformed → false, never throws.
    expect(pubKeysMatch(PUBKEY, null)).toBe(false);
    expect(pubKeysMatch(null, PUBKEY)).toBe(false);
    expect(pubKeysMatch('junk', 'junk')).toBe(false);
  });

  it('sharedSecretMatch: constant-time; empty/mismatch/length-diff → false', () => {
    expect(sharedSecretMatch('s3cr3t', 's3cr3t')).toBe(true);
    expect(sharedSecretMatch('s3cr3t', 's3cr3T')).toBe(false);
    expect(sharedSecretMatch('short', 'longer-secret')).toBe(false);
    expect(sharedSecretMatch('', 'x')).toBe(false);
    expect(sharedSecretMatch(undefined, 'x')).toBe(false);
    expect(sharedSecretMatch('x', undefined)).toBe(false);
  });
});
