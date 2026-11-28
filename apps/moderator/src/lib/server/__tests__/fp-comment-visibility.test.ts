import { beforeEach, describe, expect, it, vi } from 'vitest';

// Whose the comment is, by the ownership read; the state the primary reads back after an action.
const owner = vi.hoisted(() => ({ ids: [] as number[] }));
const readBack = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return {
    dbRead: capturingDb([], () => owner.ids.map((id) => ({ id }))),
    dbWrite: capturingDb([], () => readBack.rows),
  };
});
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));

const { setFpCommentVisibility } = await import('../fp-comment-visibility.service');

let answer: Record<string, unknown>;
let sent: unknown[];
beforeEach(() => {
  owner.ids = [];
  readBack.rows = [];
  sent = [];
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', (_url: string, init?: { body?: string }) => {
    sent.push(init?.body ? JSON.parse(init.body) : undefined);
    return Promise.resolve(
      new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  });
});

const SEEN = { version: 2, hiddenAt: '2026-11-20 01:00:00.123456+00' };

describe("a moderator's hide or unhide of a Feature Pages comment", () => {
  it('posts the state on screen, and returns the state read back', async () => {
    answer = { hidden: false };
    const state = { commentId: 5, version: 2, hidden: false, hiddenAt: null };
    readBack.rows = [state];
    await expect(
      setFpCommentVisibility({ commentId: 5, reportId: 40, hidden: false, seen: SEEN })
    ).resolves.toMatchObject({ ok: true, state: { version: 2, hidden: false } });
    expect(sent).toEqual([
      {
        commentId: 5,
        hidden: false,
        seenVersion: 2,
        seenHiddenAt: SEEN.hiddenAt,
        exceptReportId: 40,
      },
    ]);
  });

  it("names why an unhide was not made: the scan's hide points to its report", async () => {
    answer = { held: 'scan' };
    await expect(
      setFpCommentVisibility({ commentId: 5, hidden: false, seen: SEEN })
    ).resolves.toEqual({
      ok: false,
      error: 'The text scan hid this comment. Set its scan report to Unactioned to show it again.',
    });
    answer = { held: 'changed' };
    await expect(
      setFpCommentVisibility({ commentId: 5, hidden: true, seen: SEEN })
    ).resolves.toEqual({ ok: false, error: 'This comment changed since you looked. Reload.' });
  });

  it("refuses another account's comment on an account's page before anything is sent", async () => {
    answer = { hidden: true };
    await expect(
      setFpCommentVisibility({ commentId: 5, authorId: 8, hidden: true, seen: SEEN })
    ).resolves.toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });
});
