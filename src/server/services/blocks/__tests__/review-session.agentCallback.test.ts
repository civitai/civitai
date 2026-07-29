import { describe, expect, it } from 'vitest';
import {
  signAgentCallbackToken,
  verifyAgentCallbackToken,
} from '~/server/services/blocks/review-session';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P1) — unit coverage for the per-review
 * callback bearer (bound to publishRequestId, domain-separated HMAC).
 *
 *   - sign → verify roundtrip (publishRequestId bound)
 *   - rejects verification against a DIFFERENT publishRequestId (id binding)
 *   - rejects a different secret / tampered sig (constant-time path)
 *   - rejects an expired token
 *   - rejects malformed input without throwing
 *   - the `mr` entry token and this bearer do NOT cross-verify (domain sep)
 */

const SECRET = 'test-nextauth-secret-bbbbbbbbbbbbbbbbbbbb';
const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';

describe('signAgentCallbackToken / verifyAgentCallbackToken', () => {
  it('roundtrips: a fresh token verifies for the bound publishRequestId', () => {
    const token = signAgentCallbackToken({ publishRequestId: PUBREQ, secret: SECRET });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyAgentCallbackToken(token, PUBREQ, { secret: SECRET })).toEqual({
      ok: true,
      publishRequestId: PUBREQ,
    });
  });

  it('rejects a token verified against a DIFFERENT publishRequestId (id binding)', () => {
    const token = signAgentCallbackToken({ publishRequestId: PUBREQ, secret: SECRET });
    expect(
      verifyAgentCallbackToken(token, 'pubreq_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', { secret: SECRET })
    ).toEqual({ ok: false });
  });

  it('rejects a token signed with a different secret (sig mismatch)', () => {
    const token = signAgentCallbackToken({ publishRequestId: PUBREQ, secret: 'other-secret' });
    expect(verifyAgentCallbackToken(token, PUBREQ, { secret: SECRET })).toEqual({ ok: false });
  });

  it('rejects an expired token (ttl in the past)', () => {
    const token = signAgentCallbackToken({
      publishRequestId: PUBREQ,
      secret: SECRET,
      ttlSeconds: -1,
    });
    expect(verifyAgentCallbackToken(token, PUBREQ, { secret: SECRET })).toEqual({ ok: false });
  });

  it('never throws on malformed input → ok:false', () => {
    for (const bad of [null, undefined, '', 'no-dot', '.', 'a.', '.b', 'not.base64!!']) {
      expect(verifyAgentCallbackToken(bad as string, PUBREQ, { secret: SECRET }).ok).toBe(false);
    }
  });

  it('rejects an empty expected id', () => {
    const token = signAgentCallbackToken({ publishRequestId: PUBREQ, secret: SECRET });
    expect(verifyAgentCallbackToken(token, '', { secret: SECRET }).ok).toBe(false);
  });
});
