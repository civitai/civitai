import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `mintMembershipCode` — the spoke half of support's membership-code tool.
 *
 * It relays the moderator's session (so the main app records WHO minted), sends only the fields the
 * endpoint takes, and hands the code back to the page. It writes no ModActivity row of its own:
 * `/api/mod/user/membership-code` writes it inside the same transaction as the code, and a second
 * row here would double-count against the daily cap.
 */

const recordModActivity = vi.hoisted(() => vi.fn(async () => undefined));
const recordModActivityBatch = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('../mod-activity', () => ({ recordModActivity, recordModActivityBatch }));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));

const { mintMembershipCode, revokeMembershipCode } = await import('../user-actions.service');

type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: () => Response;

const INPUT = { userId: 8675309, tier: 'silver' as const, months: 2, reason: 'Ticket 123' };

beforeEach(() => {
  vi.unstubAllGlobals();
  calls = [];
  recordModActivity.mockClear();
  respond = () =>
    new Response(
      JSON.stringify({
        code: 'MB-TEST-CODE',
        expiresAt: '2026-11-12T12:00:00.000Z',
        tier: 'silver',
        months: 2,
      }),
      { status: 200 }
    );
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond());
  });
});

describe('mintMembershipCode', () => {
  it('posts to /api/mod/user/membership-code as the moderator, with exactly the endpoint fields', async () => {
    await mintMembershipCode(INPUT);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://civitai.com/api/mod/user/membership-code');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.cookie).toBe('civ-token=the-moderators-session');
    expect(calls[0].url).not.toContain('token=');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(INPUT);
  });

  it('returns the code and its expiry', async () => {
    const result = await mintMembershipCode(INPUT);
    expect(result).toEqual({
      ok: true,
      code: 'MB-TEST-CODE',
      expiresAt: '2026-11-12T12:00:00.000Z',
    });
  });

  it('writes no ModActivity row of its own', async () => {
    await mintMembershipCode(INPUT);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('carries the endpoint refusal text (e.g. the daily cap) to the operator', async () => {
    respond = () =>
      new Response(
        // The main app's real REST envelope (`restErrorBody`): `error` and `message` both carry it.
        JSON.stringify({
          error: 'Daily limit of 10 codes reached.',
          message: 'Daily limit of 10 codes reached.',
          code: 'TOO_MANY_REQUESTS',
        }),
        { status: 429 }
      );
    const result = await mintMembershipCode(INPUT);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('Daily limit of 10 codes reached.');
  });

  // Not idempotent: any answer that does not prove the request was refused or never sent must say a
  // code may exist, or the operator mints a second one.
  const MAY = /Could not confirm the code was minted/;

  it.each([500, 502, 504, 408])('a %s may have minted, and says so', async (status) => {
    respond = () => new Response(JSON.stringify({ error: 'x', message: 'x' }), { status });
    const result = await mintMembershipCode(INPUT);
    expect(!result.ok && result.error).toMatch(MAY);
  });

  it('a dropped socket after sending may have minted, and says so', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })
      )
    );
    const result = await mintMembershipCode(INPUT);
    expect(!result.ok && result.error).toMatch(MAY);
  });

  it('control: a request that never left (ECONNREFUSED) is a plain failure', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      )
    );
    const result = await mintMembershipCode(INPUT);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).not.toMatch(MAY);
  });

  it('a 200 without a code is a failure, not a success with an empty code', async () => {
    respond = () => new Response(JSON.stringify({}), { status: 200 });
    const result = await mintMembershipCode(INPUT);
    expect(result.ok).toBe(false);
  });
});

describe('revokeMembershipCode', () => {
  const REVOKE = { userId: 8675309, code: 'MB-ABCD-EF12' };

  it('posts the account and code to the revoke endpoint as the moderator', async () => {
    respond = () =>
      new Response(
        JSON.stringify({ code: 'MB-ABCD-EF12', revokedAt: '2026-10-13T12:00:00.000Z' }),
        {
          status: 200,
        }
      );
    const result = await revokeMembershipCode(REVOKE);
    expect(result).toEqual({ ok: true });
    expect(calls[0].url).toBe('https://civitai.com/api/mod/user/membership-code-revoke');
    expect((calls[0].init.headers as Record<string, string>).cookie).toBe(
      'civ-token=the-moderators-session'
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual(REVOKE);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('carries a refusal (already redeemed) to the operator', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          error: 'That code has already been redeemed.',
          message: 'That code has already been redeemed.',
          code: 'CONFLICT',
        }),
        { status: 409 }
      );
    const result = await revokeMembershipCode(REVOKE);
    expect(!result.ok && result.error).toContain('already been redeemed');
  });

  it('a lost response tells the operator to re-check the list rather than claiming failure', async () => {
    respond = () => new Response('gateway', { status: 504 });
    const result = await revokeMembershipCode(REVOKE);
    expect(!result.ok && result.error).toMatch(/Could not confirm the revoke/);
  });
});
