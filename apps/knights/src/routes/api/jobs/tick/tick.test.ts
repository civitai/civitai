import { beforeEach, describe, expect, it, vi } from 'vitest';

const escalateExpired = vi.hoisted(() => vi.fn());
const applyPendingResolutions = vi.hoisted(() => vi.fn());
const settleFinalItems = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/jobs-auth', () => ({ isJobRequest: () => true }));
vi.mock('$lib/server/queue/runtime', () => ({ queueDeps: {} }));
vi.mock('$lib/server/progression/progression', () => ({ settleFinalItems }));
vi.mock('$lib/server/queue/queue.service', () => ({ escalateExpired, applyPendingResolutions }));

const { POST } = await import('./+server');

const run = () =>
  POST({
    request: new Request('http://knights.test/api/jobs/tick', { method: 'POST' }),
  } as never);

beforeEach(() => {
  escalateExpired.mockReset();
  applyPendingResolutions.mockReset();
  settleFinalItems.mockReset();
  settleFinalItems.mockResolvedValue({ items: 0, votes: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('POST /api/jobs/tick', () => {
  it('reports both steps when both succeed', async () => {
    escalateExpired.mockResolvedValue({ escalated: 2 });
    applyPendingResolutions.mockResolvedValue({ applied: 1 });

    const response = await run();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ escalated: 2, applied: 1, settledVotes: 0 });
  });

  it('still writes back settled ratings when the escalation fails, then answers 500', async () => {
    escalateExpired.mockRejectedValue(new Error('db down'));
    applyPendingResolutions.mockResolvedValue({ applied: 1 });

    const response = await run();

    expect(applyPendingResolutions).toHaveBeenCalled();
    expect(response.status).toBe(500);
  });

  it('still escalates when the write-back fails, then answers 500', async () => {
    escalateExpired.mockResolvedValue({ escalated: 2 });
    applyPendingResolutions.mockRejectedValue(new Error('main app down'));

    const response = await run();

    expect(escalateExpired).toHaveBeenCalled();
    expect(response.status).toBe(500);
  });

  it('pays out settled votes after the write-back, even when that failed, and answers 500 if the payout fails', async () => {
    escalateExpired.mockResolvedValue({ escalated: 0 });
    applyPendingResolutions.mockRejectedValue(new Error('main app down'));
    settleFinalItems.mockRejectedValue(new Error('db down'));

    const response = await run();

    expect(settleFinalItems).toHaveBeenCalled();
    expect(response.status).toBe(500);
  });
});
