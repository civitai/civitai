import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  signReviewAccessToken,
  verifyReviewAccessToken,
  signReviewSessionCookie,
  verifyReviewSessionCookie,
  REVIEW_ACCESS_TOKEN_TTL_SECONDS,
  REVIEW_SESSION_COOKIE_TTL_SECONDS,
} from '~/server/services/blocks/review-session';

/**
 * MOD REVIEW SANDBOX (#2831) — unit coverage for the parent-minted, short-TTL,
 * mod-bound review access token (the cross-origin auth bridge).
 *
 *   - sign → verify roundtrip (host + mod bound)
 *   - tampered payload / tampered sig → ok:false
 *   - expired token → ok:false
 *   - host mismatch → ok:false
 *   - malformed input (no throw) → ok:false
 *   - constant-time path exercised (wrong-secret + wrong-length sig)
 */

const SECRET = 'test-nextauth-secret-aaaaaaaaaaaaaaaaaaaa';
const HOST = 'review-0123456789abcdef.civit.ai';
const MOD = 4242;

describe('signReviewAccessToken / verifyReviewAccessToken', () => {
  it('roundtrips: a freshly-minted token verifies for the bound host + returns modUserId', () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const result = verifyReviewAccessToken(token, HOST, { secret: SECRET });
    expect(result).toEqual({ ok: true, modUserId: MOD });
  });

  it('rejects a token verified against a DIFFERENT host (host binding)', () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    expect(verifyReviewAccessToken(token, 'review-deadbeef.civit.ai', { secret: SECRET })).toEqual({
      ok: false,
    });
  });

  it('rejects a token signed with a different secret (sig mismatch, constant-time path)', () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: 'other-secret' });
    expect(verifyReviewAccessToken(token, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it('rejects an expired token (exp in the past)', () => {
    // ttl = -1 → exp is one second in the past at mint.
    const token = signReviewAccessToken({
      modUserId: MOD,
      host: HOST,
      secret: SECRET,
      ttlSeconds: -1,
    });
    expect(verifyReviewAccessToken(token, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it('accepts a token still within TTL (boundary sanity)', () => {
    const token = signReviewAccessToken({
      modUserId: MOD,
      host: HOST,
      secret: SECRET,
      ttlSeconds: REVIEW_ACCESS_TOKEN_TTL_SECONDS,
    });
    expect(verifyReviewAccessToken(token, HOST, { secret: SECRET }).ok).toBe(true);
  });

  it('rejects a tampered payload (modUserId changed → signing string differs)', () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const [payloadB64, sigB64] = token.split('.');
    const payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    payload.m = 9999; // privilege-escalate to a different mod id
    const forgedPayloadB64 = Buffer.from(JSON.stringify(payload))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const forged = `${forgedPayloadB64}.${sigB64}`;
    expect(verifyReviewAccessToken(forged, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it('rejects a tampered signature', () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const [payloadB64] = token.split('.');
    // Replace the sig with a same-shaped but wrong value.
    const forged = `${payloadB64}.${'A'.repeat(43)}`;
    expect(verifyReviewAccessToken(forged, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it('rejects a sig of the wrong byte length without throwing (length guard before timingSafeEqual)', () => {
    const token = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
    const [payloadB64] = token.split('.');
    const forged = `${payloadB64}.AAAA`; // 3 bytes, not 32
    expect(() => verifyReviewAccessToken(forged, HOST, { secret: SECRET })).not.toThrow();
    expect(verifyReviewAccessToken(forged, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['no dot', 'notatoken'],
    ['leading dot', '.abc'],
    ['trailing dot', 'abc.'],
    ['non-json payload', `${Buffer.from('nope').toString('base64url')}.AAAA`],
    ['json-but-wrong-shape', `${Buffer.from('{"x":1}').toString('base64url')}.AAAA`],
  ])('returns ok:false (no throw) for malformed input: %s', (_label, input) => {
    expect(() =>
      verifyReviewAccessToken(input as string | null | undefined, HOST, { secret: SECRET })
    ).not.toThrow();
    expect(
      verifyReviewAccessToken(input as string | null | undefined, HOST, { secret: SECRET }).ok
    ).toBe(false);
  });

  describe('NEXTAUTH_SECRET resolution (no injected secret)', () => {
    const prev = process.env.NEXTAUTH_SECRET;
    beforeEach(() => {
      process.env.NEXTAUTH_SECRET = SECRET;
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.NEXTAUTH_SECRET;
      else process.env.NEXTAUTH_SECRET = prev;
      vi.restoreAllMocks();
    });

    it('signs + verifies using process.env.NEXTAUTH_SECRET when no secret is injected', () => {
      const token = signReviewAccessToken({ modUserId: MOD, host: HOST });
      expect(verifyReviewAccessToken(token, HOST)).toEqual({ ok: true, modUserId: MOD });
    });

    it('verify returns ok:false (no throw) when NEXTAUTH_SECRET is unset', () => {
      const token = signReviewAccessToken({ modUserId: MOD, host: HOST });
      delete process.env.NEXTAUTH_SECRET;
      expect(() => verifyReviewAccessToken(token, HOST)).not.toThrow();
      expect(verifyReviewAccessToken(token, HOST).ok).toBe(false);
    });
  });
});

describe('signReviewSessionCookie / verifyReviewSessionCookie (CHIPS subresource gate, #2847)', () => {
  it('roundtrips: a freshly-minted session cookie verifies for the bound host + returns modUserId', () => {
    const value = signReviewSessionCookie({ modUserId: MOD, host: HOST, secret: SECRET });
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyReviewSessionCookie(value, HOST, { secret: SECRET })).toEqual({
      ok: true,
      modUserId: MOD,
    });
  });

  it('rejects a session cookie verified against a DIFFERENT host (host binding)', () => {
    const value = signReviewSessionCookie({ modUserId: MOD, host: HOST, secret: SECRET });
    expect(
      verifyReviewSessionCookie(value, 'review-deadbeef.civit.ai', { secret: SECRET })
    ).toEqual({ ok: false });
  });

  it('rejects a session cookie signed with a different secret (sig mismatch)', () => {
    const value = signReviewSessionCookie({ modUserId: MOD, host: HOST, secret: 'other-secret' });
    expect(verifyReviewSessionCookie(value, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it('rejects an expired session cookie (exp in the past)', () => {
    const value = signReviewSessionCookie({
      modUserId: MOD,
      host: HOST,
      secret: SECRET,
      ttlSeconds: -1,
    });
    expect(verifyReviewSessionCookie(value, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it('accepts a session cookie still within TTL (boundary sanity)', () => {
    const value = signReviewSessionCookie({
      modUserId: MOD,
      host: HOST,
      secret: SECRET,
      ttlSeconds: REVIEW_SESSION_COOKIE_TTL_SECONDS,
    });
    expect(verifyReviewSessionCookie(value, HOST, { secret: SECRET }).ok).toBe(true);
  });

  it('rejects a tampered payload (modUserId changed → signing string differs)', () => {
    const value = signReviewSessionCookie({ modUserId: MOD, host: HOST, secret: SECRET });
    const [payloadB64, sigB64] = value.split('.');
    const payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    payload.m = 9999;
    const forgedPayloadB64 = Buffer.from(JSON.stringify(payload))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(
      verifyReviewSessionCookie(`${forgedPayloadB64}.${sigB64}`, HOST, { secret: SECRET })
    ).toEqual({ ok: false });
  });

  it('rejects a sig of the wrong byte length without throwing (length guard)', () => {
    const value = signReviewSessionCookie({ modUserId: MOD, host: HOST, secret: SECRET });
    const [payloadB64] = value.split('.');
    const forged = `${payloadB64}.AAAA`;
    expect(() => verifyReviewSessionCookie(forged, HOST, { secret: SECRET })).not.toThrow();
    expect(verifyReviewSessionCookie(forged, HOST, { secret: SECRET })).toEqual({ ok: false });
  });

  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['no dot', 'notatoken'],
    ['leading dot', '.abc'],
    ['trailing dot', 'abc.'],
    ['non-json payload', `${Buffer.from('nope').toString('base64url')}.AAAA`],
  ])('returns ok:false (no throw) for malformed input: %s', (_label, input) => {
    expect(() =>
      verifyReviewSessionCookie(input as string | null | undefined, HOST, { secret: SECRET })
    ).not.toThrow();
    expect(
      verifyReviewSessionCookie(input as string | null | undefined, HOST, { secret: SECRET }).ok
    ).toBe(false);
  });

  it('verify returns ok:false (no throw) when NEXTAUTH_SECRET is unset (fail-closed)', () => {
    const value = signReviewSessionCookie({ modUserId: MOD, host: HOST, secret: SECRET });
    const prev = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      expect(() => verifyReviewSessionCookie(value, HOST)).not.toThrow();
      expect(verifyReviewSessionCookie(value, HOST).ok).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NEXTAUTH_SECRET;
      else process.env.NEXTAUTH_SECRET = prev;
    }
  });

  // ── DOMAIN-SEPARATION: the two token types must be NON-interchangeable. This is
  //    the load-bearing isolation — an attacker who captures a 120s `mr` entry
  //    token must NOT be able to replay it as a 30min subresource session cookie,
  //    and vice-versa. ──
  describe('domain separation (entry token vs session cookie are non-interchangeable)', () => {
    it('an `mr` ENTRY token does NOT verify as a SESSION cookie', () => {
      const entry = signReviewAccessToken({ modUserId: MOD, host: HOST, secret: SECRET });
      // sanity: it IS a valid entry token
      expect(verifyReviewAccessToken(entry, HOST, { secret: SECRET }).ok).toBe(true);
      // but it MUST NOT verify as a session cookie
      expect(verifyReviewSessionCookie(entry, HOST, { secret: SECRET })).toEqual({ ok: false });
    });

    it('a SESSION cookie does NOT verify as an `mr` ENTRY token', () => {
      const sess = signReviewSessionCookie({ modUserId: MOD, host: HOST, secret: SECRET });
      expect(verifyReviewSessionCookie(sess, HOST, { secret: SECRET }).ok).toBe(true);
      expect(verifyReviewAccessToken(sess, HOST, { secret: SECRET })).toEqual({ ok: false });
    });
  });
});
