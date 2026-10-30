import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserWorkflows from '$lib/server/user-workflows.service';

const getUserGeneratedWorkflows = vi.fn();
vi.mock('$lib/server/user-workflows.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserWorkflows>()),
  getUserGeneratedWorkflows,
}));
vi.mock('$lib/server/access', () => ({ canAccess: () => true }));

const { GET } = await import('../+server');

const call = (search = '') =>
  GET({
    params: { userId: '5' },
    url: new URL(`http://x/api/user-workflows/5${search}`),
    locals: { user: { id: 1 }, grants: { 'user.generations.view': true } },
  } as never) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('/api/user-workflows when the orchestrator fails', () => {
  // Cloudflare serves its own HTML page in place of an origin 502/504, which reached the moderator as
  // `Unexpected token '<', "<!DOCTYPE "...`.
  it('answers with a status Cloudflare passes through, carrying the JSON error', async () => {
    getUserGeneratedWorkflows.mockRejectedValue(new Error('socket hang up'));
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Could not reach the orchestrator.' });
  });

  it('says the orchestrator timed out when it did', async () => {
    getUserGeneratedWorkflows.mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    );
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'The orchestrator did not answer within 90 seconds.',
    });
  });
});

describe('/api/user-workflows source', () => {
  it('passes a known source through', async () => {
    getUserGeneratedWorkflows.mockResolvedValue({ items: [], nextCursor: null });
    await call('?source=onsite');
    expect(getUserGeneratedWorkflows).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ source: 'onsite' })
    );
  });

  it('leaves an unknown source to the service default rather than erroring', async () => {
    getUserGeneratedWorkflows.mockResolvedValue({ items: [], nextCursor: null });
    const res = await call('?source=bogus');
    expect(res.status).toBe(200);
    expect(getUserGeneratedWorkflows).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ source: undefined })
    );
  });
});
