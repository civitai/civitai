import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The query this endpoint parses is the only thing between the panel's cursor and the page it serves.
 * Its fields `.catch(undefined)` so a bad value degrades rather than 500s — which also means a broken
 * schema degrades SILENTLY: an unparseable cursor is dropped and every "Next" serves the first page
 * again. The pglite tests call the service directly and cannot see that, so this goes through `GET`.
 */

const { getModActivityPage, getModActivitySummary, getRetoolActivity } = vi.hoisted(() => ({
  getModActivityPage: vi.fn(async () => ({ rows: [], next: null })),
  getModActivitySummary: vi.fn(async () => []),
  getRetoolActivity: vi.fn(async () => []),
}));

vi.mock('$lib/server/user-account.service', () => ({
  getModActivityPage,
  getModActivitySummary,
  getRetoolActivity,
}));
vi.mock('$lib/server/api-guard', () => ({
  requireUserIdParam: (_locals: unknown, params: { userId?: string }) => Number(params.userId),
}));
// `$lib/server/query` → `users.service` → `$lib/server/db`, which demands its URL at module scope.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

const { GET } = await import('../[userId]/+server');

const get = (search: string) =>
  (GET as unknown as (e: object) => Promise<Response>)({
    params: { userId: '42' },
    locals: {},
    url: new URL(`https://moderator.example/api/user-mod-activity/42?${search}`),
  });

beforeEach(() => vi.clearAllMocks());

describe('the moderator activity endpoint', () => {
  it('passes a cursor the service printed through to the next page', async () => {
    await get('before=2026-10-01T00%3A30%3A00.000&beforeId=9');
    expect(getModActivityPage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, before: { at: '2026-10-01T00:30:00.000', id: 9 } })
    );
  });

  it('drops a malformed cursor rather than casting it', async () => {
    await get("before=2026-10-01'; drop&beforeId=9");
    expect(getModActivityPage).toHaveBeenCalledWith(expect.objectContaining({ before: undefined }));
  });

  it('hides ratings unless they are asked for', async () => {
    await get('');
    expect(getModActivityPage).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'enforcement' })
    );
    await get('ratings=1&activity=buzz%3Asend&type=user');
    expect(getModActivityPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ bucket: undefined, activity: 'buzz:send', entityType: 'user' })
    );
  });

  it('serves the summary and the Retool era as their own views', async () => {
    await get('view=summary');
    expect(getModActivitySummary).toHaveBeenCalledWith(42, 'enforcement');
    await get('view=retool');
    expect(getRetoolActivity).toHaveBeenCalledWith(42);
    expect(getModActivityPage).not.toHaveBeenCalled();
  });
});
