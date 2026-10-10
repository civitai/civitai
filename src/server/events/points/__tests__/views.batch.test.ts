import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as Award from '~/server/events/points/award';

// The view hook rides /api/track/batch, the hottest route on the site. What this pins: a batch
// with no hatted entity never resolves the session, a signed-out viewer earns nothing, and the
// tracking response never waits on (or fails with) the points call.

const { awardEventPoints, getSession, hatted } = vi.hoisted(() => ({
  awardEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  getSession: vi.fn(async (): Promise<unknown> => null),
  hatted: new Set<string>(),
}));

// The engine's kill switch is on here; enabled.test.ts covers it off.
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => true,
  isEventPointsEnabledSync: () => true,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/env/other', () => ({ isDev: false, isProd: true }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    search = vi.fn();
    action = vi.fn();
    impressions = vi.fn();
    getSession = getSession;
  },
}));
vi.mock('~/server/events/points/award', async (importOriginal) => ({
  ...(await importOriginal<typeof Award>()),
  awardEventPoints,
  isHattedEntity: (entityType: string, entityId: number) => hatted.has(`${entityType}:${entityId}`),
  isHattedEntityOnceLoaded: async (entityType: string, entityId: number) =>
    hatted.has(`${entityType}:${entityId}`),
}));

import handler from '~/pages/api/track/batch';

const CREATED = new Date('2026-01-02T00:00:00Z');
const BANNED = new Date('2026-03-04T00:00:00Z');
const SIGNED_IN = { user: { id: 5, createdAt: CREATED, bannedAt: BANNED } };

function post(entities: { entityType: string; entityId: number }[]) {
  const res = {
    status: vi.fn(() => res),
    send: vi.fn(() => res),
    end: vi.fn(() => res),
  } as unknown as NextApiResponse;
  const req = {
    method: 'POST',
    headers: { host: 'civitai.com', origin: 'https://civitai.com' },
    body: [{ kind: 'impression', data: { sessionKey: 'k', surface: 'images', entities } }],
  } as unknown as NextApiRequest;
  return {
    req,
    res,
    done: (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res),
  };
}

// The hook is fire-and-forget; let its promise chain settle before asserting on what it did.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  hatted.clear();
  getSession.mockResolvedValue(SIGNED_IN);
});

describe('POST /api/track/batch event points', () => {
  it('awards views of hatted entities to a signed-in viewer', async () => {
    hatted.add('Image:11');
    const { res, done } = post([
      { entityType: 'Image', entityId: 11 },
      { entityType: 'Model', entityId: 22 },
    ]);
    await done;
    await settle();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(awardEventPoints).toHaveBeenCalledWith([
      {
        type: 'view',
        actorId: 5,
        // The account, so the engine can skip new and banned accounts live.
        actor: { createdAt: CREATED, bannedAt: BANNED },
        entityType: 'Image',
        entityId: 11,
      },
    ]);
  });

  it('awards nothing to a signed-out viewer', async () => {
    hatted.add('Image:11');
    getSession.mockResolvedValue(null);
    const { done } = post([{ entityType: 'Image', entityId: 11 }]);
    await done;
    await settle();

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(awardEventPoints).not.toHaveBeenCalled();
  });

  it('never resolves the session for a batch with no hatted entity', async () => {
    const { res, done } = post([{ entityType: 'Image', entityId: 11 }]);
    await done;
    await settle();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(getSession).not.toHaveBeenCalled();
    expect(awardEventPoints).not.toHaveBeenCalled();
  });

  it('responds before the points call settles, and is not failed by it', async () => {
    hatted.add('Image:11');
    let release!: (session: unknown) => void;
    getSession.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const { res, done } = post([{ entityType: 'Image', entityId: 11 }]);
    await done;

    // The response is sent while the session (and so the award) is still pending.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(awardEventPoints).not.toHaveBeenCalled();

    release(SIGNED_IN);
    await settle();
    expect(awardEventPoints).toHaveBeenCalledTimes(1);
  });
});

describe('token sessions', () => {
  it('awards nothing to a session from an API key or bearer token', async () => {
    hatted.add('Image:11');
    getSession.mockResolvedValue({ ...SIGNED_IN, tokenScope: 1 });
    const { done } = post([{ entityType: 'Image', entityId: 11 }]);
    await done;
    await settle();

    expect(awardEventPoints).not.toHaveBeenCalled();
  });
});
