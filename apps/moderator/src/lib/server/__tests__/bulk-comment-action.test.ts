import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordModActivity = vi.hoisted(() => vi.fn(async (_row: { activity: string }) => undefined));
// The selected ids the ownership check finds under another author; every other read returns nothing.
const foreign = vi.hoisted(() => ({ ids: [] as number[] }));
const readSql = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const rows = (sql: string) =>
    sql.includes('"CommentV3"') ? foreign.ids.map((id) => ({ id })) : [];
  return { dbRead: capturingDb(readSql, rows), dbWrite: capturingDb([], []) };
});
vi.mock('../mod-activity', () => ({ recordModActivity, recordModActivityBatch: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://civitai.com', WEBHOOK_TOKEN: 'shared-secret' },
}));
vi.mock('$app/server', () => ({
  getRequestEvent: () => ({
    locals: {},
    request: { headers: new Headers({ cookie: 'civ-token=the-moderators-session' }) },
  }),
}));

const { bulkCommentAction } = await import('../user-actions.service');

let body: Record<string, unknown>;
let sent: unknown;
let batches: number[];

beforeEach(() => {
  foreign.ids = [];
  readSql.length = 0;
  sent = undefined;
  vi.unstubAllGlobals();
  recordModActivity.mockClear();
  batches = [];
  vi.stubGlobal('fetch', (_url: string, init?: { body?: string }) => {
    sent = init?.body ? JSON.parse(init.body) : undefined;
    batches.push((sent as { commentIds: number[] }).commentIds.length);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  });
});

const run = (action: 'bulkDelete' | 'removeAsTos' | 'restoreFromTos') =>
  bulkCommentAction({ action, commentIds: [1, 2, 3], userId: 8, moderatorId: 9 });
const activities = () => recordModActivity.mock.calls.map(([row]) => row.activity);

describe('a selection holding another account’s comment', () => {
  it('is refused before anything reaches the main app', async () => {
    foreign.ids = [3];
    body = { deleted: 3 };

    await expect(run('bulkDelete')).resolves.toMatchObject({ ok: false });
    expect(readSql.find((q) => q.includes('"CommentV3"'))).toMatch(/"userId" != \$\d/);
    expect(sent).toBeUndefined();
    expect(activities()).toEqual([]);
  });
});

describe('a selection over the endpoint’s 500-id limit', () => {
  it('goes out in batches the endpoint accepts, and counts every batch', async () => {
    const ids = Array.from({ length: 1_200 }, (_, i) => i + 1);
    body = { deleted: 400 };

    await expect(
      bulkCommentAction({ action: 'bulkDelete', commentIds: ids, userId: 8, moderatorId: 9 })
    ).resolves.toEqual({ ok: true, affected: 1_200 });
    expect(batches).toEqual([500, 500, 200]);
  });
});

describe('a selection holding a comment deleted since it was ticked', () => {
  it('still goes through, and the short count reports the missing one', async () => {
    body = { deleted: 2 };

    await expect(run('bulkDelete')).resolves.toMatchObject({ ok: true, affected: 2 });
    expect(sent).toEqual({ commentIds: [1, 2, 3] });
  });
});

describe('bulk comment delete', () => {
  it('sends the ids in the field the endpoint reads', async () => {
    body = { deleted: 3, affected: { commentIds: [1, 2, 3] } };

    await run('bulkDelete');
    expect(sent).toEqual({ commentIds: [1, 2, 3] });
  });

  it('fails, and logs nothing, when no row was deleted', async () => {
    body = { deleted: 0, affected: { commentIds: [1, 2, 3] } };

    await expect(run('bulkDelete')).resolves.toMatchObject({ ok: false });
    expect(activities()).toEqual([]);
  });

  it('reports a short count as the count deleted', async () => {
    body = { deleted: 2, affected: { commentIds: [1, 2, 3] } };

    await expect(run('bulkDelete')).resolves.toEqual({ ok: true, affected: 2 });
    expect(activities()).toEqual(['comments:bulkDelete:2']);
  });
});

describe('a ToS restore', () => {
  it('is a failure the moderator sees when a clear errored, logging only what did change', async () => {
    body = {
      comments: { count: 1, reopenedReports: 1, failed: 1 },
      affected: { commentIds: [1, 2, 3] },
    };

    await expect(run('restoreFromTos')).resolves.toEqual({
      ok: false,
      error: '1 could not be restored and stay hidden. Restored 1.',
    });
    expect(activities()).toEqual(['comments:restoreFromTos:1']);
  });

  it('is a failure, not "nothing changed", when every clear errored', async () => {
    body = {
      comments: { count: 0, reopenedReports: 0, failed: 3 },
      affected: { commentIds: [1, 2, 3] },
    };

    await expect(run('restoreFromTos')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('3 could not be restored'),
    });
    expect(activities()).toEqual([]);
  });

  it('reports a short count as the count restored', async () => {
    body = { comments: { count: 2, reopenedReports: 1 }, affected: { commentIds: [1, 2, 3] } };

    await expect(run('restoreFromTos')).resolves.toEqual({ ok: true, affected: 2 });
    expect(activities()).toEqual(['comments:restoreFromTos:2']);
  });
});

describe('a ToS removal', () => {
  it('reads the count from the comments section', async () => {
    body = {
      comments: { count: 3, notified: 1, rewardedReports: 0 },
      affected: { commentIds: [1, 2, 3] },
    };

    await expect(run('removeAsTos')).resolves.toEqual({ ok: true, affected: 3 });
    expect(activities()).toEqual(['comments:removeAsTos:3']);
  });
});
