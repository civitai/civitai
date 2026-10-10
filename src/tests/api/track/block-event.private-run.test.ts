import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The custom-events ingest and the REAL private-run predicate together.
 *
 * `block-event.test.ts` mocks the predicate, so it pins only that the ingest asks it and obeys.
 * Here the predicate runs for real over its three leaf inputs, to pin the one state in which it
 * can say yes on this route: the ingest's cached approved-app read still lists an app that the
 * approved-id set already knows is no longer approved. Everywhere else a private run is of a
 * non-approved app and is dropped before the predicate is reached.
 */

const { mockInsert, mockFlag, mockAccess, sessionStore } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockFlag: { isAppBlocksPrivateRunEnabled: vi.fn() },
  mockAccess: { resolvePrivateRunAccess: vi.fn() },
  sessionStore: { session: null as { user?: { id: number } } | null },
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/env/other', () => ({ isDev: false, isProd: false, isTest: true, isPreview: false }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: () => Promise.resolve(sessionStore.session),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { insert: mockInsert } }));
vi.mock('~/server/services/app-blocks-flag', () => mockFlag);
vi.mock('~/server/services/blocks/private-run-access.service', () => mockAccess);

const APP = 'apb_just_delisted';
const REVIEWER = { id: 9101 };

type FindManyArgs = { select?: { manifest?: boolean } };

/** `stale`: the ingest's wide read still lists the app; the id set no longer does. */
function world(kind: 'stale' | 'approved-in-both') {
  dbMock.dbRead.appBlock.findMany.mockImplementation(async (args: FindManyArgs) => {
    if (args?.select?.manifest) {
      return [
        { id: APP, app: { userId: 6611 }, manifest: { analytics: { events: { opened: {} } } } },
      ];
    }
    return kind === 'stale' ? [{ id: 'apb_some_other_app' }] : [{ id: APP }];
  });
}

async function post(): Promise<number> {
  const handler = (await import('~/pages/api/track/block-event')).default as unknown as (
    req: NextApiRequest,
    res: NextApiResponse
  ) => Promise<unknown>;
  const res = {} as NextApiResponse;
  res.status = vi.fn(() => res) as unknown as NextApiResponse['status'];
  res.send = vi.fn(() => res) as unknown as NextApiResponse['send'];
  res.end = vi.fn(() => res) as unknown as NextApiResponse['end'];
  await handler(
    {
      method: 'POST',
      headers: { host: 'civitai.com', origin: 'https://civitai.com' },
      body: JSON.stringify({
        events: [
          { appBlockId: APP, blockInstanceId: 'page_apb_just_delisted', eventName: 'opened' },
        ],
      }),
    } as unknown as NextApiRequest,
    res
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(res.status).toHaveBeenCalledWith(200);
  return mockInsert.mock.calls.length;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockInsert.mockImplementation(async () => undefined);
  mockFlag.isAppBlocksPrivateRunEnabled.mockResolvedValue(true);
  mockAccess.resolvePrivateRunAccess.mockResolvedValue({ allowed: true, audience: 'moderator' });
  sessionStore.session = { user: REVIEWER };
});

describe('custom events and the real private-run predicate', () => {
  it('🔴 writes nothing for a private run of an app the ingest still believes is approved', async () => {
    world('stale');
    expect(await post()).toBe(0);
    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ by: { appBlockId: APP }, viewer: REVIEWER })
    );
  });

  it('writes the row when the predicate refuses the same viewer', async () => {
    world('stale');
    mockAccess.resolvePrivateRunAccess.mockResolvedValue({ allowed: false, reason: 'no-role' });
    expect(await post()).toBe(1);
    expect(mockAccess.resolvePrivateRunAccess).toHaveBeenCalledTimes(1);
  });

  it('writes the row for an approved app without doing the predicate work at all', async () => {
    world('approved-in-both');
    expect(await post()).toBe(1);
    expect(mockFlag.isAppBlocksPrivateRunEnabled).not.toHaveBeenCalled();
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
  });

  it('writes the row for a signed-out viewer, who can never be on a private run', async () => {
    world('stale');
    sessionStore.session = null;
    // No trusted address is sent, so a signed-out row is dropped before the write for that
    // reason; the claim here is only that the predicate did no work.
    await post();
    expect(mockAccess.resolvePrivateRunAccess).not.toHaveBeenCalled();
  });
});
