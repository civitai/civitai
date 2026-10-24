import { beforeEach, describe, expect, it, vi } from 'vitest';

const getJobQueueHealth = vi.hoisted(() => vi.fn(async () => ({ queues: [] })));
vi.mock('$lib/server/job-queue.service', () => ({ getJobQueueHealth }));

const { GET } = await import('../+server');

const call = (locals: Record<string, unknown>) =>
  GET({ locals } as unknown as Parameters<typeof GET>[0]) as Promise<Response>;

describe('GET /api/job-queue-health', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a request with no moderator session, before reading anything', async () => {
    const res = await call({ tokenClient: 'webhook', grants: {} });
    expect(res.status).toBe(401);
    expect(getJobQueueHealth).not.toHaveBeenCalled();
  });

  it('returns the queue health to a signed-in moderator', async () => {
    const res = await call({ user: { id: 7, roles: [] }, grants: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queues: [] });
  });
});
