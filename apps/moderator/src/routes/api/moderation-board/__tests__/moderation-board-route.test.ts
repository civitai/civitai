import { describe, expect, it, vi } from 'vitest';

const board = vi.hoisted(() => ({
  getRecentQueueActivity: vi.fn(async () => new Map()),
  getRecentModActivity: vi.fn(async () => []),
  getSweepCounts: vi.fn(async () => []),
  getTaskLag: vi.fn(async () => []),
}));
vi.mock('$lib/server/moderation-board.service', () => board);
vi.mock('$lib/server/bounded', () => ({ bounded: (fn: () => Promise<unknown>) => fn() }));

const { GET } = await import('../+server');

const call = (locals: Record<string, unknown>) =>
  GET({ locals } as unknown as Parameters<typeof GET>[0]) as Promise<Response>;

describe('GET /api/moderation-board', () => {
  it('refuses a request with no moderator session, before reading anything', async () => {
    const res = await call({ tokenClient: 'webhook', grants: {} });
    expect(res.status).toBe(401);
    expect(board.getRecentQueueActivity).not.toHaveBeenCalled();
    expect(board.getRecentModActivity).not.toHaveBeenCalled();
  });

  it('returns the board to a signed-in moderator', async () => {
    const res = await call({ user: { id: 7, roles: [] }, grants: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ activity: [], lag: [], sweeps: [] });
  });
});
