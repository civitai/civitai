import { beforeEach, describe, expect, it, vi } from 'vitest';

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
let sent: unknown;

beforeEach(() => {
  vi.unstubAllGlobals();
  recordModActivity.mockClear();
  vi.stubGlobal('fetch', (_url: string, init?: { body?: string }) => {
    sent = init?.body ? JSON.parse(init.body) : undefined;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  });
});

const run = (action: 'bulkDelete' | 'restoreFromTos') =>
  bulkCommentAction({ action, commentIds: [1, 2, 3], userId: 8, moderatorId: 9 });
const activities = () => recordModActivity.mock.calls.map(([row]) => row.activity);

describe('bulk comment delete', () => {
  it('sends the CommentV3 ids in the field the endpoint reads', async () => {
    body = { commentV2Deleted: 3 };

    await run('bulkDelete');
    expect(sent).toEqual({ commentV2Ids: [1, 2, 3] });
  });

  it('fails, and logs nothing, when no row was deleted', async () => {
    body = { commentV2Deleted: 0 };

    await expect(run('bulkDelete')).resolves.toMatchObject({ ok: false });
    expect(activities()).toEqual([]);
  });

  it('reports a short count as the count deleted', async () => {
    body = { commentV2Deleted: 2 };

    await expect(run('bulkDelete')).resolves.toEqual({ ok: true, affected: 2 });
    expect(activities()).toEqual(['comments:bulkDelete:2']);
  });
});

describe('a ToS restore', () => {
  it('is a failure the moderator sees when a clear errored, logging only what did change', async () => {
    body = { commentV2: { count: 1, reopenedReports: 1, failed: 1 } };

    await expect(run('restoreFromTos')).resolves.toEqual({
      ok: false,
      error: '1 could not be restored and stay hidden. Restored 1.',
    });
    expect(activities()).toEqual(['comments:restoreFromTos:1']);
  });

  it('is a failure, not "nothing changed", when every clear errored', async () => {
    body = { commentV2: { count: 0, reopenedReports: 0, failed: 3 } };

    await expect(run('restoreFromTos')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('3 could not be restored'),
    });
    expect(activities()).toEqual([]);
  });

  it('reports a short count as the count restored', async () => {
    body = { commentV2: { count: 2, reopenedReports: 1 } };

    await expect(run('restoreFromTos')).resolves.toEqual({ ok: true, affected: 2 });
    expect(activities()).toEqual(['comments:restoreFromTos:2']);
  });
});
