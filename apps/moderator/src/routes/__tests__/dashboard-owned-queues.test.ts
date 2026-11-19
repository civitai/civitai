import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as QueueOwners from '$lib/server/queue-owners';

/**
 * The dashboard's My tasks view rests on one read of the viewer's owned queues. When that read fails the
 * load must say "unknown" (`null`), which the page turns into Everything with no switch, and never `[]`
 * or an error: either would hide every queue behind an empty My tasks or take the dashboard down.
 */

const { ownedQueuePaths } = vi.hoisted(() => ({ ownedQueuePaths: vi.fn() }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/queue-owners', async (importOriginal) => ({
  ...(await importOriginal<typeof QueueOwners>()),
  ownedQueuePaths,
}));

const { load } = await import('../+page.server');

const run = () =>
  (load as unknown as (e: unknown) => Promise<{ ownedQueues: string[] | null }>)({
    url: new URL('https://moderator.example/'),
    locals: { user: { id: 7, roles: [] } },
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('dashboard owned queues', () => {
  it('hands the page the viewer’s own queues', async () => {
    ownedQueuePaths.mockResolvedValue(['/images/a']);
    expect((await run()).ownedQueues).toEqual(['/images/a']);
    expect(ownedQueuePaths).toHaveBeenCalledWith(7);
  });

  it('a failed read is unknown, not "owns nothing", and does not fail the dashboard', async () => {
    ownedQueuePaths.mockRejectedValue(Object.assign(new Error('no table'), { code: '42P01' }));
    expect((await run()).ownedQueues).toBeNull();
  });
});
