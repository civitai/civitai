import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The spoke half of the Creator Score grant tool.
 *
 * It relays the moderator's session (so the main app records WHO granted), sends only the fields the
 * endpoint takes, and writes no ModActivity row of its own: the endpoint writes it in the same
 * transaction as the grant.
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

const { grantCreatorScore, revokeCreatorScoreGrant } = await import('../user-actions.service');

type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: () => Response;

const INPUT = { userId: 8675309, amount: 250, reason: 'Contest judge' };

beforeEach(() => {
  vi.unstubAllGlobals();
  calls = [];
  recordModActivity.mockClear();
  respond = () =>
    new Response(
      JSON.stringify({ id: 7, amount: 250, createdAt: '2026-10-14T12:00:00.000Z', total: 1250 }),
      { status: 200 }
    );
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond());
  });
});

describe('grantCreatorScore', () => {
  it('posts to /api/mod/user/creator-score-grant as the moderator, with exactly the endpoint fields', async () => {
    await grantCreatorScore(INPUT);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://civitai.com/api/mod/user/creator-score-grant');
    expect((calls[0].init.headers as Record<string, string>).cookie).toBe(
      'civ-token=the-moderators-session'
    );
    expect(calls[0].url).not.toContain('token=');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(INPUT);
  });

  it('returns the new total and writes no ModActivity row of its own', async () => {
    expect(await grantCreatorScore(INPUT)).toEqual({ ok: true, total: 1250 });
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('carries the endpoint refusal text (e.g. the daily cap) to the operator', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          error: 'Daily limit of 20 Creator Score grants per moderator reached.',
          message: 'Daily limit of 20 Creator Score grants per moderator reached.',
          code: 'TOO_MANY_REQUESTS',
        }),
        { status: 429 }
      );
    const result = await grantCreatorScore(INPUT);
    expect(!result.ok && result.error).toContain('Daily limit of 20');
  });

  // Not idempotent: any answer that does not prove the request was refused or never sent must say a
  // grant may exist, or the operator grants a second time.
  const MAY = /Could not confirm the grant/;

  it.each([500, 502, 504, 408])('a %s may have granted, and says so', async (status) => {
    respond = () => new Response(JSON.stringify({ error: 'x', message: 'x' }), { status });
    const result = await grantCreatorScore(INPUT);
    expect(!result.ok && result.error).toMatch(MAY);
  });

  it('a dropped socket after sending may have granted, and says so', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } })
      )
    );
    const result = await grantCreatorScore(INPUT);
    expect(!result.ok && result.error).toMatch(MAY);
  });

  it('control: a request that never left (ECONNREFUSED) is a plain failure', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      )
    );
    const result = await grantCreatorScore(INPUT);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).not.toMatch(MAY);
  });

  it('a 200 without a total is a failure, not a success', async () => {
    respond = () => new Response(JSON.stringify({}), { status: 200 });
    expect((await grantCreatorScore(INPUT)).ok).toBe(false);
  });
});

describe('revokeCreatorScoreGrant', () => {
  const REVOKE = { userId: 8675309, grantId: 7, reason: 'Wrong account' };

  it('posts the account, grant and reason to the revoke endpoint as the moderator', async () => {
    respond = () =>
      new Response(JSON.stringify({ id: 7, revokedAt: '2026-10-14T12:00:00.000Z', total: 1000 }), {
        status: 200,
      });
    expect(await revokeCreatorScoreGrant(REVOKE)).toEqual({ ok: true, total: 1000 });
    expect(calls[0].url).toBe('https://civitai.com/api/mod/user/creator-score-grant-revoke');
    expect((calls[0].init.headers as Record<string, string>).cookie).toBe(
      'civ-token=the-moderators-session'
    );
    expect(JSON.parse(String(calls[0].init.body))).toEqual(REVOKE);
    expect(recordModActivity).not.toHaveBeenCalled();
  });

  it('a 200 without a total is a failure, not a success', async () => {
    respond = () => new Response(JSON.stringify({ id: 7 }), { status: 200 });
    expect((await revokeCreatorScoreGrant(REVOKE)).ok).toBe(false);
  });

  it('carries a refusal (already revoked) to the operator', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          error: 'That grant has already been revoked.',
          message: 'That grant has already been revoked.',
          code: 'CONFLICT',
        }),
        { status: 409 }
      );
    const result = await revokeCreatorScoreGrant(REVOKE);
    expect(!result.ok && result.error).toContain('already been revoked');
  });

  it('a lost response tells the operator to re-check the list rather than claiming failure', async () => {
    respond = () => new Response('gateway', { status: 504 });
    const result = await revokeCreatorScoreGrant(REVOKE);
    expect(!result.ok && result.error).toMatch(/Could not confirm the revoke/);
  });
});
