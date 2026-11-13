import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared-layout queue route (`/reports/[queue=entityQueue]`): which slugs reach it, that its layout
 * reads nothing that changes when the moderator moves between items, what each page opens, and the
 * article queue's own action.
 */

const getReports = vi.fn(async () => ({
  items: [] as { id: number; entityId: number | null; reportedById: number }[],
  totalItems: 0,
  page: 1,
  limit: 50,
}));
const getReportedEntityId = vi.fn(
  async (_type: string, _reportId: number) => 29013 as number | null
);
vi.mock('$lib/server/reports.service', () => ({
  getReports,
  getReportStatusCounts: vi.fn(async () => ({})),
  getReportedEntityId,
}));
const queueSubjects = vi.fn(async () => new Map());
const loadEntityItem = vi.fn(async (type: string, id: number) => ({
  id,
  type,
  reports: [],
  evidence: { kind: type },
}));
vi.mock('$lib/server/entity-queue-load', () => ({ queueSubjects, loadEntityItem }));
const moderateArticle = vi.fn(async () => ({ ok: true }));
vi.mock('$lib/server/article-moderation', () => ({ moderateArticle }));
vi.mock('$lib/server/report-actions', () => ({ reportModerationActions: () => ({}) }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/users.service', () => ({
  MAX_INT4: 2_147_483_647,
  usersByIds: vi.fn(async () => new Map()),
}));
const canAccess = vi.fn((_user: unknown, _path: string) => true);
vi.mock('$lib/server/access', () => ({ canAccess }));

const { match } = await import('../../../../params/entityQueue');
const { load: layoutLoad } = await import('../+layout.server');
const { load: indexLoad } = await import('../+page.server');
const { load: itemLoad } = await import('../[id]/+page.server');
const { entityQueueActions } = await import('../actions.server');

const locals = { user: { id: 1, username: 'mod' }, grants: {} };
const url = (path: string) => new URL(`https://mod.example${path}`);

beforeEach(() => {
  vi.clearAllMocks();
  canAccess.mockImplementation(() => true);
});

describe('the entityQueue matcher', () => {
  it.each(['article', 'chat', 'collection', 'bounty', 'bounty-entry'])('takes %s', (slug) => {
    expect(match(slug)).toBe(true);
  });

  // Their own routes win anyway; the table types must fall through to `[slug]`.
  it.each(['user', 'model', 'post', 'image', 'comment', 'model-comment', 'game', 'storyline'])(
    'leaves %s to its own route or the tables',
    (slug) => expect(match(slug)).toBe(false)
  );
});

describe('the queue layout', () => {
  // SvelteKit reruns a load whose tracked URL reads changed. `get`/`getAll`/`has` are tracked per key;
  // iterating the query string or reading the path makes the queue rerun on every click.
  it('reads only its own params, never the whole query or the path', async () => {
    const real = url('/reports/article/5?status=Pending&imgPage=2');
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
    // `params.id` belongs to the item; reading it would rerun the queue on every item opened.
    const params = new Proxy({ queue: 'article', id: '5' } as Record<string, string>, {
      get(target, key) {
        if (key !== 'queue') throw new Error(`params.${String(key)} changes with the open item`);
        return target[key];
      },
    });

    const data = await layoutLoad({ url: tracked, params, locals } as never);
    expect(touched).toContain('status');
    expect(touched).not.toContain('imgPage');
    expect(data).toMatchObject({ queueType: 'article', fullBleed: true });
  });

  it('reads the queue for its own type, with each row given its subject', async () => {
    getReports.mockResolvedValueOnce({
      items: [{ id: 9, entityId: 70, reportedById: 3 }],
      totalItems: 1,
      page: 1,
      limit: 50,
    });
    queueSubjects.mockResolvedValueOnce(new Map([[9, { title: 'A chat' }]]));

    const data = (await layoutLoad({
      url: url('/reports/chat'),
      params: { queue: 'chat' },
      locals,
    } as never)) as {
      items: { subject: unknown }[];
    };

    expect(getReports).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat' }));
    expect(queueSubjects).toHaveBeenCalledWith('chat', expect.any(Array));
    expect(data.items[0].subject).toEqual({ title: 'A chat' });
  });
});

describe('the item pages', () => {
  it('the bare queue opens its first item, of the queue type', async () => {
    const parent = async () => ({
      queueType: 'collection',
      items: [
        { id: 1, entityId: null },
        { id: 2, entityId: 40 },
      ],
    });
    const u = url('/reports/collection?imgPage=2');
    await indexLoad({ parent, locals, url: u } as never);
    expect(loadEntityItem).toHaveBeenCalledWith('collection', 40, locals, u);
  });

  it('an empty queue opens nothing', async () => {
    const parent = async () => ({ queueType: 'article', items: [] });
    expect(await indexLoad({ parent, locals, url: url('/reports/article') } as never)).toEqual({
      item: null,
    });
  });

  it('opens the item in the path', async () => {
    const u = url('/reports/bounty-entry/314775');
    await itemLoad({ params: { queue: 'bounty-entry', id: '314775' }, locals, url: u } as never);
    expect(loadEntityItem).toHaveBeenCalledWith('bountyEntry', 314775, locals, u);
  });

  it.each(['abc', '0', '-4', '99999999999'])('a path id of %s is a 404', async (id) => {
    await expect(
      itemLoad({ params: { queue: 'article', id }, locals } as never)
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('unpublishArticle', () => {
  const event = (queue: string, fields: Record<string, string>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    return {
      params: { queue },
      locals: { user: { id: 7 }, grants: {} },
      request: new Request('https://mod.example/', { method: 'POST', body }),
    } as never;
  };
  const status = (r: unknown) => (r as { status?: number }).status;

  it('unpublishes as a violation with the reason and message', async () => {
    const result = await entityQueueActions.unpublishArticle(
      event('article', { reportId: '501', reason: 'spam', customMessage: ' advert ' })
    );
    expect(result).toEqual({ success: true });
    expect(getReportedEntityId).toHaveBeenCalledWith('article', 501);
    expect(moderateArticle).toHaveBeenCalledWith({
      action: 'unpublish',
      articleId: 29013,
      userId: 7,
      reason: 'spam',
      customMessage: 'advert',
    });
  });

  // The article comes from the report, never the form: a stale tab or a hand-built POST must not
  // unpublish an article nobody reported.
  it('refuses a report that names no article', async () => {
    getReportedEntityId.mockResolvedValueOnce(null);
    const r = await entityQueueActions.unpublishArticle(
      event('article', { reportId: '9', reason: 'spam' })
    );
    expect(status(r)).toBe(410);
    expect(moderateArticle).not.toHaveBeenCalled();
  });

  // The form posts to whichever queue is open; on any other it is not this queue's to run.
  it('refuses on another queue', async () => {
    const r = await entityQueueActions.unpublishArticle(
      event('chat', { reportId: '1', reason: 'spam' })
    );
    expect(status(r)).toBe(403);
    expect(moderateArticle).not.toHaveBeenCalled();
  });

  // The site lets any moderator unpublish an article, so this asks no more than the queue does.
  it('needs only the article queue, not /users', async () => {
    canAccess.mockImplementation((_u, path) => path !== '/users');
    const ok = await entityQueueActions.unpublishArticle(
      event('article', { reportId: '1', reason: 'spam' })
    );
    expect(ok).toEqual({ success: true });

    canAccess.mockImplementation((_u, path) => path !== '/reports/article');
    const r = await entityQueueActions.unpublishArticle(
      event('article', { reportId: '1', reason: 'spam' })
    );
    expect(status(r)).toBe(403);
    expect(canAccess).toHaveBeenCalledWith({ id: 7 }, '/reports/article');
  });

  it('refuses a reason the site does not know', async () => {
    const r = await entityQueueActions.unpublishArticle(
      event('article', { reportId: '1', reason: 'nope' })
    );
    expect(status(r)).toBe(400);
  });

  // `other` has no wording of its own: without the message the author is told nothing.
  it('needs a message for Other', async () => {
    const r = await entityQueueActions.unpublishArticle(
      event('article', { reportId: '1', reason: 'other' })
    );
    expect(status(r)).toBe(400);
    expect(moderateArticle).not.toHaveBeenCalled();
  });

  it('says why the article could not be unpublished', async () => {
    moderateArticle.mockResolvedValueOnce({
      ok: false,
      error: 'Article is not published',
    } as never);
    const r = await entityQueueActions.unpublishArticle(
      event('article', { reportId: '1', reason: 'spam' })
    );
    expect(r).toMatchObject({ status: 409, data: { error: 'Article is not published' } });
  });
});
