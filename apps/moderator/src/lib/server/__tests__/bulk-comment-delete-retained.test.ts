import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `bulkCommentAction`'s delete when the endpoint kept some comments hidden instead: the kept count
 * reaches the page, a batch it only kept is still a success, and each outcome gets its own
 * `ModActivity` row.
 */

const recordModActivity = vi.hoisted(() => vi.fn(async (_row: { activity: string }) => undefined));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
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

beforeEach(() => {
  vi.unstubAllGlobals();
  recordModActivity.mockClear();
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
  );
});

const del = () =>
  bulkCommentAction({
    action: 'bulkDelete',
    commentIds: [1, 2],
    commentV2Ids: [3],
    userId: 8,
    moderatorId: 9,
  });
const activities = () => recordModActivity.mock.calls.map(([row]) => row.activity);

describe('bulk comment delete with comments kept hidden', () => {
  it('reports the kept count and logs each outcome', async () => {
    body = { commentDeleted: 1, commentV2Deleted: 1, retainedHidden: 1 };

    await expect(del()).resolves.toEqual({ ok: true, affected: 2, retainedHidden: 1 });
    expect(activities()).toEqual(['comments:bulkDelete:2', 'comments:bulkDelete:retainedHidden:1']);
  });

  it('is a success when every comment was kept, and logs no delete', async () => {
    body = { commentDeleted: 0, commentV2Deleted: 0, retainedHidden: 3 };

    await expect(del()).resolves.toEqual({ ok: true, affected: 0, retainedHidden: 3 });
    expect(activities()).toEqual(['comments:bulkDelete:retainedHidden:3']);
  });

  it('still fails when nothing was deleted or kept', async () => {
    body = { commentDeleted: 0, commentV2Deleted: 0, retainedHidden: 0 };

    await expect(del()).resolves.toMatchObject({ ok: false });
    expect(activities()).toEqual([]);
  });
});

describe('a ToS restore with comments kept hidden', () => {
  const restore = () =>
    bulkCommentAction({
      action: 'restoreFromTos',
      commentIds: [1, 2],
      commentV2Ids: [3],
      userId: 8,
      moderatorId: 9,
    });

  it('is a success when every comment stayed hidden, and logs only that', async () => {
    body = {
      comment: { count: 0, reopenedReports: 0, retainedHidden: 2 },
      commentV2: { count: 0, reopenedReports: 0, retainedHidden: 1 },
    };

    await expect(restore()).resolves.toEqual({ ok: true, affected: 0, retainedHidden: 3 });
    expect(activities()).toEqual(['comments:restoreFromTos:retainedHidden:3']);
  });

  it('reports the restored and kept counts apart', async () => {
    body = {
      comment: { count: 1, reopenedReports: 0, retainedHidden: 1 },
      commentV2: { count: 1, reopenedReports: 1, retainedHidden: 0 },
    };

    await expect(restore()).resolves.toEqual({ ok: true, affected: 2, retainedHidden: 1 });
  });
});
