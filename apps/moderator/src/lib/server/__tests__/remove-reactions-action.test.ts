import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `countReactions` / `removeReactions` — the spoke half of the reaction erasure. They relay the
 * moderator's session, send the confirmation, read the endpoint's answer, and, like `deleteAccount`,
 * write no `ModActivity` row of their own: the endpoint writes it against the acting moderator.
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

const { countReactions, removeReactions } = await import('../user-actions.service');

const TARGET = 8675309;
const MAY_HAVE_COMPLETED =
  'Could not confirm the removal. Count the reactions again to see what is left.';

type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: () => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.unstubAllGlobals();
  calls = [];
  recordModActivity.mockClear();
  recordModActivityBatch.mockClear();
  respond = () => json({ userId: TARGET, removed: { ImageReaction: 2 }, remaining: 0 });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond());
  });
});

describe('removeReactions', () => {
  it('posts the id and confirmation to the endpoint as the moderator, and logs nothing itself', async () => {
    const result = await removeReactions({ userId: TARGET, username: 'someone' });

    expect(result).toEqual({ ok: true, removed: { ImageReaction: 2 }, remaining: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://civitai.com/api/mod/user/remove-reactions');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ userId: TARGET, username: 'someone' });
    expect(new Headers(calls[0].init.headers).get('cookie')).toContain('the-moderators-session');
    expect(recordModActivity).not.toHaveBeenCalled();
    expect(recordModActivityBatch).not.toHaveBeenCalled();
  });

  it('sends no username field for an account without one', async () => {
    await removeReactions({ userId: TARGET });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ userId: TARGET });
  });

  it("passes the endpoint's refusal through", async () => {
    respond = () =>
      // The main app's 4xx pass-through envelope: `{ message }` alone.
      json({ message: 'That username does not belong to user 8675309.' }, 400);
    const result = await removeReactions({ userId: TARGET, username: 'someone' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('That username does not belong');
      expect(result.error).not.toBe(MAY_HAVE_COMPLETED);
    }
  });

  it.each([
    ['a 5xx', () => json({ error: 'error' }, 502)],
    ['a 408', () => json({ error: 'timeout' }, 408)],
    ['a 200 that is not the success shape', () => json({ ok: 'maybe' })],
    ['a non-numeric remaining', () => json({ removed: { ImageReaction: 1 }, remaining: '0' })],
  ])('treats %s as a removal that may have happened', async (_, answer) => {
    respond = answer;
    expect(await removeReactions({ userId: TARGET, username: 'someone' })).toEqual({
      ok: false,
      error: MAY_HAVE_COMPLETED,
    });
  });
});

describe('countReactions', () => {
  it('reads the counts with a GET', async () => {
    respond = () => json({ userId: TARGET, counts: { ImageReaction: 3, CommentReaction: 0 } });
    const result = await countReactions(TARGET);

    expect(result).toEqual({ ok: true, counts: { ImageReaction: 3, CommentReaction: 0 } });
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].url).toBe(`https://civitai.com/api/mod/user/reactions?userId=${TARGET}`);
  });

  it('refuses an answer whose counts are not numbers', async () => {
    respond = () => json({ counts: { ImageReaction: '3' } });
    expect((await countReactions(TARGET)).ok).toBe(false);
  });
});
