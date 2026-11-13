import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserWorkflows from '$lib/server/user-workflows.service';

const getUserGeneratedWorkflows = vi.fn();
const getUserWorkflowsByIds = vi.fn();
vi.mock('$lib/server/user-workflows.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserWorkflows>()),
  getUserGeneratedWorkflows,
  getUserWorkflowsByIds,
}));
vi.mock('$lib/server/access', () => ({ canAccess: () => true }));

const { GET } = await import('../+server');

const call = (search = '', grants: Record<string, boolean> = { 'user.generations.view': true }) =>
  GET({
    params: { userId: '5' },
    url: new URL(`http://x/api/user-workflows/5${search}`),
    locals: { user: { id: 1 }, grants },
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

describe('/api/user-workflows ids', () => {
  it.each([['?ids=5-20260101000000000'], ['?ids='], ['?ids=junk,,%3Cx%3E']])(
    'answers %s from the by-id lookup, never the full history',
    async (search) => {
      getUserWorkflowsByIds.mockResolvedValue({
        items: [],
        notFound: [],
        unchecked: [],
        invalid: 0,
        overCap: 0,
        cap: 200,
      });
      const res = await call(search);
      expect(res.status).toBe(200);
      expect(getUserGeneratedWorkflows).not.toHaveBeenCalled();
      expect(getUserWorkflowsByIds).toHaveBeenCalledWith(
        5,
        new URL(`http://x${search}`).searchParams.get('ids')
      );
    }
  );

  it('fails as a 503 with no list when the by-id lookup throws', async () => {
    getUserWorkflowsByIds.mockRejectedValue(new Error('Orchestrator is not configured.'));
    const res = await call('?ids=5-20260101000000000');
    expect(res.status).toBe(503);
    expect(getUserGeneratedWorkflows).not.toHaveBeenCalled();
  });

  it('refuses the by-id read without user.generations.view', async () => {
    await expect(call('?ids=5-20260101000000000', {})).rejects.toMatchObject({ status: 403 });
    expect(getUserWorkflowsByIds).not.toHaveBeenCalled();
  });
});
