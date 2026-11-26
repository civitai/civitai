import { describe, expect, it, vi } from 'vitest';

vi.mock('../../redis', () => ({ getSysRedis: () => ({}) }));
const { readBrake } = await import('../brake');

const closed = () =>
  Promise.reject(Object.assign(new Error('The client is closed'), { name: 'ClientClosedError' }));

describe('readBrake', () => {
  it('reads again when the client has not connected yet, so a cold start does not hold a send', async () => {
    const get = vi.fn().mockImplementationOnce(closed).mockResolvedValueOnce(null);
    expect(await readBrake({ get, retryMs: 0 })).toEqual({ paused: false });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the brake stays unreadable', async () => {
    const get = vi.fn().mockImplementation(closed);
    expect(await readBrake({ get, retryMs: 0 })).toMatchObject({
      paused: true,
      reason: 'brake unreadable',
    });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('reports a pause that is set', async () => {
    const get = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ by: 7, at: '2026-11-21T00:00:00Z', reason: 'checking' }));
    expect(await readBrake({ get })).toMatchObject({ paused: true, by: 7, reason: 'checking' });
  });
});
