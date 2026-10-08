import { describe, expect, it, vi } from 'vitest';
import {
  createPlannerBackend,
  isPlannerAction,
  isPlannerReadAction,
  PLANNER_ACTIONS,
  plannerRequest,
} from '../contract.js';

describe('the action table', () => {
  it('splits reads from writes by method', () => {
    expect(Object.keys(PLANNER_ACTIONS).filter((a) => isPlannerReadAction(a as never))).toEqual([
      'scheduled',
      'detail',
    ]);
    expect(isPlannerAction('schedule')).toBe(true);
    expect(isPlannerAction('toString')).toBe(false);
    expect(isPlannerAction('nope')).toBe(false);
  });
});

describe('plannerRequest', () => {
  it('puts a read on the query string, dropping undefined', () => {
    const { url, init } = plannerRequest('/api/planner', 'scheduled', {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      modelVersionId: undefined,
    });
    expect(url).toBe(
      '/api/planner/scheduled?from=2026-10-01T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z'
    );
    expect(init).toEqual({ method: 'GET' });
  });

  it('sends a write as a JSON body', () => {
    const { url, init } = plannerRequest('/api/v1/posts/planner', 'shift', {
      ids: [1, 2],
      deltaMinutes: 60,
    });
    expect(url).toBe('/api/v1/posts/planner/shift');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ ids: [1, 2], deltaMinutes: 60 });
  });
});

describe('createPlannerBackend', () => {
  const ok = (data: unknown) =>
    ({ ok: true, status: 200, json: async () => data } as unknown as Response);
  const refused = (status: number, body: unknown) =>
    ({ ok: false, status, json: async () => body } as unknown as Response);

  it('maps each backend method onto its action', async () => {
    const fetchLike = vi.fn(async () => ok({ done: true }));
    const backend = createPlannerBackend('/api/planner', fetchLike);

    await backend.getScheduled({ from: 'a', to: 'b', modelVersionId: 30 });
    await backend.getPostDetail(11);
    await backend.reschedule({ id: 11, publishedAt: 'c', expectedScope: 'post' });
    await backend.publishNow({ id: 11, expectedScope: 'version' });
    await backend.unschedule([11, 12]);
    await backend.shift({ ids: [11], deltaMinutes: -30 });

    const calls = fetchLike.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [init.method, url])).toEqual([
      ['GET', '/api/planner/scheduled?from=a&to=b&modelVersionId=30'],
      ['GET', '/api/planner/detail?id=11'],
      ['POST', '/api/planner/schedule'],
      ['POST', '/api/planner/schedule'],
      ['POST', '/api/planner/unschedule'],
      ['POST', '/api/planner/shift'],
    ]);
    expect(JSON.parse(calls[2][1].body as string)).toEqual({
      id: 11,
      publishedAt: 'c',
      expectedScope: 'post',
    });
    expect(JSON.parse(calls[3][1].body as string)).toEqual({
      id: 11,
      expectedScope: 'version',
      publishNow: true,
    });
    expect(JSON.parse(calls[4][1].body as string)).toEqual({ ids: [11, 12] });
  });

  it('rejects with the server message, falling back to the status', async () => {
    const backend = createPlannerBackend(
      '/api/planner',
      vi
        .fn<(...args: unknown[]) => Promise<Response>>()
        .mockResolvedValueOnce(refused(409, { error: 'This post moved', code: 'CONFLICT' }))
        .mockResolvedValueOnce(refused(429, { message: 'Slow down' }))
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          json: async () => {
            throw new Error('not json');
          },
        } as unknown as Response)
    );

    await expect(backend.unschedule([1])).rejects.toThrow('This post moved');
    await expect(backend.unschedule([1])).rejects.toThrow('Slow down');
    await expect(backend.unschedule([1])).rejects.toThrow('Request failed (502).');
  });
});
