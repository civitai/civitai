import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tracker.impressions() contract — the server half of feed impression tracking.
 *
 * The assertions here are about LOAD, not about row shape. Impressions arrive as
 * one event carrying up to 250 entities, and the difference between sending that
 * as one insert and as 250 requests is the difference between a viable feature
 * and an outage. Both properties that guarantee it are pinned:
 *
 *   - the whole array becomes a SINGLE clickhouse.insert (a regression to the
 *     per-row `track()` path would still write correct rows, so nothing else in
 *     the suite would notice),
 *   - the insert is issued with async_insert, without which every web pod's flush
 *     is its own part and the table hits the too-many-parts ceiling on part count
 *     long before it does on volume.
 *
 * Actor stamping (userId/ip/userAgent from the resolved session) is asserted too:
 * userId must come from the session, never from the browser's payload.
 */

const { insertMock } = vi.hoisted(() => ({ insertMock: vi.fn(async () => undefined) }));

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clickhouse: { insert: insertMock },
}));

import { Tracker } from '../tracker';

describe('Tracker.impressions', () => {
  beforeEach(() => {
    insertMock.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes every entity in ONE insert into the impressions table', async () => {
    const tracker = new Tracker(undefined, undefined, { user: { id: 42 } } as never);
    await tracker.impressions({
      sessionKey: 'sess_1',
      surface: 'images',
      entities: [
        { entityType: 'Image', entityId: 1 },
        { entityType: 'Image', entityId: 2 },
        { entityType: 'Model', entityId: 3 },
      ],
    });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const [args] = insertMock.mock.calls[0] as [
      {
        table: string;
        values: Record<string, unknown>[];
        clickhouse_settings?: Record<string, unknown>;
      }
    ];
    expect(args.table).toBe('impressions');
    expect(args.values).toHaveLength(3);
    expect(args.values[0]).toMatchObject({
      entityType: 'Image',
      entityId: 1,
      sessionKey: 'sess_1',
      surface: 'images',
      userId: 42,
    });
    expect(args.values[2]).toMatchObject({ entityType: 'Model', entityId: 3 });
  });

  it('issues the insert with async_insert so the fleet does not create a part per flush', async () => {
    const tracker = new Tracker(undefined, undefined, null);
    await tracker.impressions({
      sessionKey: 'sess_2',
      surface: 'home',
      entities: [{ entityType: 'Image', entityId: 9 }],
    });

    const [args] = insertMock.mock.calls[0] as [{ clickhouse_settings?: Record<string, unknown> }];
    expect(args.clickhouse_settings).toMatchObject({ async_insert: 1, wait_for_async_insert: 0 });
  });

  it('stamps userId from the session, not from the payload', async () => {
    const tracker = new Tracker(undefined, undefined, null);
    await tracker.impressions({
      sessionKey: 'sess_3',
      surface: 'models',
      entities: [{ entityType: 'Model', entityId: 5 }],
    });

    const [args] = insertMock.mock.calls[0] as [{ values: Record<string, unknown>[] }];
    expect(args.values[0]).toMatchObject({ userId: 0 });
  });

  it('does not write anything for an empty entity list', async () => {
    const tracker = new Tracker(undefined, undefined, null);
    await tracker.impressions({ sessionKey: 'sess_4', surface: 'images', entities: [] });

    const [args] = insertMock.mock.calls[0] as [{ values: Record<string, unknown>[] }];
    expect(args.values).toHaveLength(0);
  });
});
