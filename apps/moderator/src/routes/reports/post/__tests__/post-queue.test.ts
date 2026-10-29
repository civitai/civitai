import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportStatus } from '$lib/reports';

/**
 * The post queue's own route: that its layout reads nothing that changes when the moderator moves
 * between posts and tabs, what each tab loads, the old Retool path, and the queue's sweep.
 */

const getReports = vi.fn(async () => ({
  items: [] as { id: number; entityId: number | null }[],
  totalItems: 0,
  page: 1,
  limit: 50,
}));
const setReportStatus = vi.fn();
vi.mock('$lib/server/reports.service', () => ({
  getReports,
  getReportStatusCounts: vi.fn(async () => ({})),
  getUnpublishedSourceCounts: vi.fn(async () => ({})),
  setReportStatus,
}));
const getPostLookup = vi.fn(async (id: number) => ({
  post: { id, userId: 31 },
  images: [],
  truncated: false,
  total: 0,
}));
const getRecentImagesOutsidePost = vi.fn(async () => [{ id: 9 }]);
vi.mock('$lib/server/image-lookup.service', () => ({
  getPostLookup,
  getRecentImagesOutsidePost,
  postsByIds: vi.fn(async () => new Map()),
}));
const loadAccountHistory = vi.fn(async () => ({ strikes: [] }));
vi.mock('$lib/server/account-history', () => ({ loadAccountHistory }));
const getResolvedPostReportIds = vi.fn(async () => [] as number[]);
vi.mock('$lib/server/moderation-board.service', () => ({ getResolvedPostReportIds }));
vi.mock('$lib/server/report-actions', () => ({ reportModerationActions: () => ({}) }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/users.service', () => ({ MAX_INT4: 2_147_483_647 }));
vi.mock('$lib/server/access', () => ({ canAccess: vi.fn(() => true) }));

const { load: layoutLoad } = await import('../+layout.server');
const { load: indexLoad } = await import('../+page.server');
const { load: postLoad } = await import('../[postId]/[[tab=postTab]]/+page.server');
const { postQueueActions } = await import('../actions.server');

const locals = { user: { id: 1, username: 'mod' }, grants: {} };
const url = (path: string) => new URL(`https://mod.example${path}`);
type Item = { item: { postId: number; tab: string; accountHistory: unknown } | null };
const runPost = (params: { postId: string; tab?: string }) =>
  postLoad({ params, locals } as never) as Promise<Item>;
const event = () =>
  ({ locals: { user: { id: 7 }, grants: {} }, getClientAddress: () => '203.0.113.9' } as never);
const failure = (result: unknown) => (result as { status: number }).status;

beforeEach(() => vi.clearAllMocks());

describe('the queue layout', () => {
  // SvelteKit reruns a load whose tracked URL reads changed. `get`/`getAll`/`has` are tracked per key;
  // iterating the query string or reading the path makes the queue rerun on every click.
  it('reads only its own params, never the whole query or the path', async () => {
    const real = url('/reports/post/5/owner?status=Pending&imgPage=2');
    const touched: string[] = [];
    const searchParams = new Proxy(real.searchParams, {
      get(target, key) {
        if (key === 'get' || key === 'getAll' || key === 'has')
          return (k: string) => {
            touched.push(k);
            return (target[key] as (k: string) => unknown).call(target, k);
          };
        throw new Error(`searchParams.${String(key)} reads the whole query string`);
      },
    });
    const tracked = new Proxy(real, {
      get(target, key) {
        if (key === 'searchParams') return searchParams;
        throw new Error(`url.${String(key)} is tracked as a whole`);
      },
    });

    await layoutLoad({ url: tracked, locals } as never);
    expect(touched).toContain('status');
    expect(touched).not.toContain('imgPage');
  });

  it('narrows to one unpublish reason, and ignores one it does not know', async () => {
    await layoutLoad({ url: url('/reports/post?unpublished=nudify'), locals } as never);
    expect(getReports).toHaveBeenCalledWith(
      expect.objectContaining({ unpublishedReason: 'nudify' })
    );

    getReports.mockClear();
    await layoutLoad({ url: url('/reports/post?unpublished=banana'), locals } as never);
    expect(getReports).toHaveBeenCalledWith(
      expect.objectContaining({ unpublishedReason: undefined })
    );
  });
});

describe('the post pages', () => {
  it('the bare queue opens its first post, on Images', async () => {
    const parent = async () => ({
      items: [
        { id: 1, entityId: null },
        { id: 2, entityId: 40 },
      ],
    });
    const data = (await indexLoad({ parent, locals } as never)) as Item;
    expect(data.item).toMatchObject({ postId: 40, tab: 'images' });
  });

  it("loads the post's own open reports, by the post", async () => {
    await runPost({ postId: '40' });
    expect(getReports).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'post', entityId: 40, statuses: ['Pending', 'Processing'] })
    );
  });

  // The owner's history is the heavy read, and a report is usually settled from the images.
  it("reads the owner's history on its own tab only", async () => {
    expect((await runPost({ postId: '40' })).item?.accountHistory).toBeNull();
    expect(loadAccountHistory).not.toHaveBeenCalled();

    const owner = await runPost({ postId: '40', tab: 'owner' });
    expect(loadAccountHistory).toHaveBeenCalledWith(31, 'mod');
    expect(owner.item?.accountHistory).not.toBeNull();
  });

  it("shows the owner's other images beside the post's, excluding the post itself", async () => {
    await runPost({ postId: '40' });
    expect(getRecentImagesOutsidePost).toHaveBeenCalledWith(31, 40);
  });

  it('a path that is not a post id is a 404', async () => {
    await expect(runPost({ postId: 'abc' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('actionResolvedPosts', () => {
  it('counts what actually changed, not how many ids it looped over', async () => {
    getResolvedPostReportIds.mockResolvedValue([1, 2, 3]);
    setReportStatus
      .mockResolvedValueOnce({ ok: true, changed: true })
      .mockResolvedValueOnce({ ok: true, changed: false })
      .mockResolvedValueOnce({ ok: false, error: 'gone' });

    const result = await postQueueActions.actionResolvedPosts(event());

    expect(result).toMatchObject({ success: true, actioned: 1, skipped: 2, found: 3 });
  });

  it('sweeps as Actioned — the content was removed, so the reports were right', async () => {
    getResolvedPostReportIds.mockResolvedValue([1]);
    setReportStatus.mockResolvedValue({ ok: true, changed: true });

    await postQueueActions.actionResolvedPosts(event());

    expect(setReportStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: ReportStatus.Actioned })
    );
  });

  it('flags a full batch as probably having more behind it', async () => {
    getResolvedPostReportIds.mockResolvedValue(Array.from({ length: 500 }, (_, i) => i + 1));
    setReportStatus.mockResolvedValue({ ok: true, changed: true });

    const result = await postQueueActions.actionResolvedPosts(event());

    expect(result).toMatchObject({ more: true, found: 500 });
  });

  it('does not claim a sweep when there was nothing to sweep', async () => {
    getResolvedPostReportIds.mockResolvedValue([]);

    const result = await postQueueActions.actionResolvedPosts(event());

    expect(failure(result)).toBe(400);
    expect(setReportStatus).not.toHaveBeenCalled();
  });
});
