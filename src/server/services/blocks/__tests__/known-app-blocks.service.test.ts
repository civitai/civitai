import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

import {
  boundAppBlockIdLabel,
  getApprovedAppBlockAnalytics,
  isConfirmedNonApprovedAppBlockId,
  isKnownAppBlockId,
  _internalsForTests,
} from '../known-app-blocks.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockFindMany = dbMock.dbRead.appBlock.findMany;

beforeEach(() => {
  vi.clearAllMocks();
  _internalsForTests.reset();
  mockFindMany.mockResolvedValue([{ id: 'apb_known_1' }, { id: 'apb_known_2' }]);
});

describe('known-app-blocks.service', () => {
  it('preserves an approved app id and buckets an unknown one to "other"', async () => {
    expect(await boundAppBlockIdLabel('apb_known_1')).toBe('apb_known_1');
    expect(await boundAppBlockIdLabel('apb_attacker_garbage')).toBe('other');
    expect(await isKnownAppBlockId('apb_known_2')).toBe(true);
    expect(await isKnownAppBlockId('apb_nope')).toBe(false);
  });

  it('queries only status:"approved"', async () => {
    await isKnownAppBlockId('apb_known_1');
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { status: 'approved' },
      select: { id: true },
    });
  });

  it('TTL-caches — a second lookup in the window does not re-query the DB', async () => {
    await isKnownAppBlockId('apb_known_1');
    await isKnownAppBlockId('apb_known_2');
    await boundAppBlockIdLabel('apb_known_1');
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it('fails SAFE on a DB error — unknown set, everything buckets to "other"', async () => {
    mockFindMany.mockRejectedValueOnce(new Error('engine down'));
    expect(await boundAppBlockIdLabel('apb_known_1')).toBe('other');
  });
});

/**
 * 🔴 `isConfirmedNonApprovedAppBlockId` IS NOT THE NEGATION OF `isKnownAppBlockId`, and
 * the difference only shows up in the failure case — which is exactly where a consumer
 * using the negation as a cheap pre-filter would escalate every request into expensive
 * work against a database that has just stopped answering. These two cases are the whole
 * reason the export exists; without them, deleting `trusted &&` from its body is a
 * change no test can see.
 */
describe('isConfirmedNonApprovedAppBlockId [INV]', () => {
  it('answers TRUE for an id outside a successfully-read approved set', async () => {
    expect(await isConfirmedNonApprovedAppBlockId('apb_nope')).toBe(true);
  });

  it('answers FALSE for an approved id — and agrees with isKnownAppBlockId when trusted', async () => {
    expect(await isConfirmedNonApprovedAppBlockId('apb_known_1')).toBe(false);
    // The two forms coincide on the happy path. That coincidence is what makes the
    // failure case below the only discriminating measurement.
    expect(await isKnownAppBlockId('apb_known_1')).toBe(true);
  });

  it('🔴 answers FALSE FOR EVERYTHING while the set is UNTRUSTED, where the negation says TRUE', async () => {
    mockFindMany.mockRejectedValue(new Error('engine down'));
    // The negation's answer, measured rather than asserted from the docblock: with the
    // load failed, an approved app looks unknown.
    expect(await isKnownAppBlockId('apb_known_1')).toBe(false);
    // The confirmed form refuses to turn that into a claim about the app.
    expect(await isConfirmedNonApprovedAppBlockId('apb_known_1')).toBe(false);
    expect(await isConfirmedNonApprovedAppBlockId('apb_nope')).toBe(false);
  });

  it('stays FALSE for the whole cached failure window, not just the first call', async () => {
    // A failed load is cached for the TTL. If `trusted` were recomputed per call rather
    // than stored on the entry, the second call inside the window would read a stale
    // `true` off the cache and the amplification would return after one request.
    mockFindMany.mockRejectedValue(new Error('engine down'));
    expect(await isConfirmedNonApprovedAppBlockId('apb_nope')).toBe(false);
    expect(await isConfirmedNonApprovedAppBlockId('apb_nope')).toBe(false);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });
});

describe('getApprovedAppBlockAnalytics — owner and declared events of an approved app', () => {
  const manifest = {
    name: 'not projected',
    analytics: {
      events: {
        level_cleared: {
          description: 'not projected either',
          properties: {
            difficulty: { type: 'enum', values: ['calm', 'brutal'] },
            seconds: { type: 'number' },
            assisted: { type: 'boolean' },
          },
        },
        menu_opened: {},
      },
    },
  };

  it('projects the declared events and the owner, and nothing else of the manifest', async () => {
    mockFindMany.mockResolvedValue([{ id: 'apb_declares', manifest, app: { userId: 6611 } }]);
    const analytics = await getApprovedAppBlockAnalytics('apb_declares');
    expect(analytics?.ownerUserId).toBe(6611);
    expect([...analytics!.events.keys()]).toEqual(['level_cleared', 'menu_opened']);
    const props = analytics!.events.get('level_cleared')!;
    expect([...props.keys()]).toEqual(['difficulty', 'seconds', 'assisted']);
    expect(props.get('difficulty')).toEqual({ type: 'enum', values: new Set(['calm', 'brutal']) });
    expect(props.get('seconds')).toEqual({ type: 'number' });
    expect(props.get('assisted')).toEqual({ type: 'boolean' });
    expect(analytics!.events.get('menu_opened')!.size).toBe(0);
    expect(JSON.stringify([...analytics!.events])).not.toContain('not projected');
    expect(Object.keys(analytics!).sort()).toEqual(['events', 'ownerUserId']);
  });

  it('answers null for an id outside the approved set', async () => {
    mockFindMany.mockResolvedValue([{ id: 'apb_declares', manifest, app: { userId: 6611 } }]);
    expect(await getApprovedAppBlockAnalytics('apb_someone_else')).toBeNull();
  });

  it('a manifest with ANY analytics error declares nothing, including its valid events', async () => {
    const half = {
      analytics: {
        events: {
          level_cleared: manifest.analytics.events.level_cleared,
          // One bad property type poisons the whole declaration.
          broken: { properties: { note: { type: 'string' } } },
        },
      },
    };
    mockFindMany.mockResolvedValue([{ id: 'apb_half', manifest: half, app: { userId: 6611 } }]);
    const analytics = await getApprovedAppBlockAnalytics('apb_half');
    expect(analytics).not.toBeNull();
    expect(analytics!.events.size).toBe(0);
    expect(analytics!.ownerUserId).toBe(6611);
  });

  it.each([
    ['no analytics key', { name: 'x' }],
    ['a null manifest', null],
    ['a manifest that is not an object', 'oops'],
    ['an undeclared row shape', undefined],
  ])('declares nothing for %s', async (_label, value) => {
    mockFindMany.mockResolvedValue([{ id: 'apb_plain', manifest: value, app: { userId: 6611 } }]);
    const analytics = await getApprovedAppBlockAnalytics('apb_plain');
    expect(analytics).toEqual({ ownerUserId: 6611, events: new Map() });
  });

  it('has no owner when the row carries none', async () => {
    mockFindMany.mockResolvedValue([{ id: 'apb_orphan', manifest, app: null }, { id: 'apb_bare' }]);
    expect((await getApprovedAppBlockAnalytics('apb_orphan'))?.ownerUserId).toBeNull();
    expect(await getApprovedAppBlockAnalytics('apb_bare')).toEqual({
      ownerUserId: null,
      events: new Map(),
    });
  });

  it('reads approved rows only, once per cache lifetime, with its own query', async () => {
    mockFindMany.mockResolvedValue([{ id: 'apb_declares', manifest, app: { userId: 6611 } }]);
    // Cold and concurrent first: the callers must share one read.
    const concurrent = await Promise.all(
      [1, 2, 3].map(() => getApprovedAppBlockAnalytics('apb_declares'))
    );
    expect(concurrent.map((a) => a?.ownerUserId)).toEqual([6611, 6611, 6611]);
    await getApprovedAppBlockAnalytics('apb_declares');
    await getApprovedAppBlockAnalytics('apb_someone_else');
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { status: 'approved' },
      select: { id: true, manifest: true, app: { select: { userId: true } } },
    });
  });

  it('the approved-id set does not load it, and survives its failure', async () => {
    // The id set is what the other beacons clamp their labels with; the wider read must not be
    // able to empty it.
    const isWide = (args: { select?: { manifest?: boolean } }) => args?.select?.manifest === true;
    mockFindMany.mockImplementation(async (args) => {
      if (isWide(args)) throw new Error('wide read failed');
      return [{ id: 'apb_known_1' }];
    });
    expect(await isKnownAppBlockId('apb_known_1')).toBe(true);
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(isWide(mockFindMany.mock.calls[0][0])).toBe(false);

    expect(await getApprovedAppBlockAnalytics('apb_known_1')).toBeNull();
    expect(await isKnownAppBlockId('apb_known_1')).toBe(true);
    expect(await isConfirmedNonApprovedAppBlockId('apb_known_1')).toBe(false);
  });

  it('answers null for every id while the lookup is failing', async () => {
    mockFindMany.mockRejectedValue(new Error('engine down'));
    expect(await getApprovedAppBlockAnalytics('apb_declares')).toBeNull();
  });

  describe('cache lifetimes', () => {
    const T0 = Date.UTC(2031, 2, 14, 12, 0, 0);
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-reads after five minutes, not before', async () => {
      mockFindMany.mockResolvedValue([{ id: 'apb_declares', manifest, app: { userId: 6611 } }]);
      await getApprovedAppBlockAnalytics('apb_declares');
      vi.setSystemTime(T0 + 299_000);
      await getApprovedAppBlockAnalytics('apb_declares');
      expect(mockFindMany).toHaveBeenCalledTimes(1);
      vi.setSystemTime(T0 + 301_000);
      await getApprovedAppBlockAnalytics('apb_declares');
      expect(mockFindMany).toHaveBeenCalledTimes(2);
    });

    it('caches a FAILED read for 15 seconds only, then recovers', async () => {
      mockFindMany.mockRejectedValueOnce(new Error('engine down'));
      mockFindMany.mockResolvedValue([{ id: 'apb_declares', manifest, app: { userId: 6611 } }]);
      expect(await getApprovedAppBlockAnalytics('apb_declares')).toBeNull();
      vi.setSystemTime(T0 + 14_000);
      expect(await getApprovedAppBlockAnalytics('apb_declares')).toBeNull();
      expect(mockFindMany).toHaveBeenCalledTimes(1);
      vi.setSystemTime(T0 + 16_000);
      expect((await getApprovedAppBlockAnalytics('apb_declares'))?.ownerUserId).toBe(6611);
      expect(mockFindMany).toHaveBeenCalledTimes(2);
    });
  });
});
