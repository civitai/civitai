import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// One session lookup per request: the track batch route fires many track() calls and, for event
// points, a getSession() in the same tick, and each used to start its own lookup.

const { getServerAuthSession } = vi.hoisted(() => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession }));

import { Tracker } from '~/server/clickhouse/tracker';

const req = { headers: {}, socket: {} } as unknown as NextApiRequest;
const res = {} as NextApiResponse;
const SESSION = { user: { id: 5 } };

beforeEach(() => {
  vi.clearAllMocks();
  getServerAuthSession.mockReset();
});

describe('Tracker.getSession', () => {
  it('returns the resolved session', async () => {
    getServerAuthSession.mockResolvedValue(SESSION);
    await expect(new Tracker(req, res).getSession()).resolves.toBe(SESSION);
  });

  it('shares one lookup between calls that start before it lands', async () => {
    let release!: (session: unknown) => void;
    getServerAuthSession.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const tracker = new Tracker(req, res);

    const calls = [tracker.getSession(), tracker.getSession(), tracker.getSession()];
    release(SESSION);

    expect(await Promise.all(calls)).toEqual([SESSION, SESSION, SESSION]);
    expect(getServerAuthSession).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed lookup', async () => {
    getServerAuthSession.mockRejectedValueOnce(new Error('hub down')).mockResolvedValue(SESSION);
    const tracker = new Tracker(req, res);

    await expect(tracker.getSession()).resolves.toBeNull();
    await expect(tracker.getSession()).resolves.toBe(SESSION);
    expect(getServerAuthSession).toHaveBeenCalledTimes(2);
  });

  it('does no lookup when the caller already supplied the session', async () => {
    await expect(new Tracker(req, res, SESSION as never).getSession()).resolves.toBe(SESSION);
    expect(getServerAuthSession).not.toHaveBeenCalled();
  });
});
