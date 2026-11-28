import { beforeEach, describe, expect, it, vi } from 'vitest';

// Whose the comment is, by the ownership read; the state the primary reads back after an action.
const owner = vi.hoisted(() => ({
  ids: [] as number[],
  sql: [] as string[],
  params: [] as unknown[][],
}));
const readBack = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return {
    dbRead: capturingDb(owner.sql, () => owner.ids.map((id) => ({ id })), owner.params),
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
  owner.sql.length = 0;
  owner.params.length = 0;
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
    ).resolves.toMatchObject({
      ok: true,
      state: { version: 2, hidden: false },
      message: expect.stringContaining('once this report is closed'),
    });
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
    // The read is scoped to that comment and that author.
    expect(owner.sql).toHaveLength(1);
    expect(owner.sql[0]).toMatch(/"id" = \$1 and "userId" = \$2/);
    expect(owner.params[0]).toEqual([5, 8]);
  });

  it("hides the account's own comment, bound to the version on screen", async () => {
    owner.ids = [5];
    answer = { hidden: true };
    readBack.rows = [{ commentId: 5, version: 2, hidden: true, hiddenAt: SEEN.hiddenAt }];
    await expect(
      setFpCommentVisibility({ commentId: 5, authorId: 8, hidden: true, seen: SEEN })
    ).resolves.toMatchObject({ ok: true, state: { hidden: true } });
    expect(sent).toEqual([{ commentId: 5, hidden: true, seenVersion: 2 }]);
  });

  it('names a text the scan has not cleared yet', async () => {
    answer = { held: 'scanning' };
    await expect(
      setFpCommentVisibility({ commentId: 5, hidden: false, seen: SEEN })
    ).resolves.toEqual({
      ok: false,
      error: 'The text scan has not cleared this text yet. Try again once it has.',
    });
  });
});
