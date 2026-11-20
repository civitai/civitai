import { describe, expect, it, vi } from 'vitest';
import { hashToUnit } from '~/server/clickhouse/sampled-row-buffer';
import {
  allowedFilters,
  buildFeedEventRow,
  createFeedEventsRecorder,
  parseSampleRate,
} from '~/server/services/feed-events.service';
import type { TrackFeedInput } from '~/server/schema/track.schema';

const load: TrackFeedInput = {
  event: 'load',
  sessionKey: 's1',
  feed: 'models',
  page: '/models',
  sort: 'Hot',
  pageIndex: 2,
  filters: {},
};

describe('feed events', () => {
  it('keeps only the allowlisted filters of the feed, and no over-long value', () => {
    expect(
      allowedFilters('models', {
        hidePaid: 'true',
        username: 'someone',
        query: 'free text',
        baseModels: 'x'.repeat(500),
      })
    ).toEqual({ hidePaid: 'true' });
  });

  it('drops a value that is not shaped like a filter option, and maps a free-text sort to other', () => {
    expect(allowedFilters('models', { baseModels: 'SDXL 1.0,Pony', period: '<script>' })).toEqual({
      baseModels: 'SDXL 1.0,Pony',
    });
    const viewer = { userId: 1, memberType: 'undefined' };
    expect(buildFeedEventRow({ ...load, sort: 'Most Downloaded' }, viewer, 0).sort).toBe(
      'Most Downloaded'
    );
    expect(buildFeedEventRow({ ...load, sort: 'hello <b>you</b>' }, viewer, 0).sort).toBe('other');
  });

  it('a filter allowed on one feed is dropped on a feed that does not list it', () => {
    expect(allowedFilters('posts', { hidePaid: 'true', period: 'Week' })).toEqual({
      period: 'Week',
    });
  });

  it('keeps click fields only on clicks and seen ids only on seen rows', () => {
    const extra = { entityType: 'Model' as const, entityId: 7, position: 3, seenIds: [1, 2] };
    const viewer = { userId: 5, memberType: 'gold' };
    const asLoad = buildFeedEventRow({ ...load, ...extra }, viewer, 0);
    const asClick = buildFeedEventRow({ ...load, ...extra, event: 'click' }, viewer, 0);
    const asSeen = buildFeedEventRow({ ...load, ...extra, event: 'seen' }, viewer, 0);
    expect([asLoad.entityId, asLoad.position, asLoad.seenIds]).toEqual([0, 0, []]);
    expect([asClick.entityType, asClick.entityId, asClick.position]).toEqual(['Model', 7, 3]);
    expect(asSeen.seenIds).toEqual([1, 2]);
  });

  it('samples by session key, and resolves the viewer only for a kept session', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const kept = keys.find((k) => hashToUnit(k) < 0.5)!;
    const dropped = keys.find((k) => hashToUnit(k) >= 0.5)!;
    const insert = vi.fn(async (_rows: { sessionKey: string }[]) => undefined);
    const recorder = createFeedEventsRecorder({
      getConfig: async () => ({ sampleRate: 0.5, until: Number.POSITIVE_INFINITY }),
      insert,
      // A per-row roll would drop every row: only the key decides.
      random: () => 0.99,
    });
    const getViewer = vi.fn(async () => ({ userId: 1, memberType: 'undefined' }));

    for (const sessionKey of [kept, dropped, kept, dropped])
      await recorder.record({ ...load, sessionKey }, getViewer);
    await recorder.flush();

    expect(insert.mock.calls[0]?.[0].map((row) => row.sessionKey)).toEqual([kept, kept]);
    expect(getViewer).toHaveBeenCalledTimes(2);
  });

  it('reads the Flipt variant key as the sample rate, off for anything else', () => {
    expect([
      parseSampleRate('0.1'),
      parseSampleRate('1'),
      parseSampleRate('5'),
      parseSampleRate('ten'),
      parseSampleRate(undefined),
      parseSampleRate('-0.2'),
    ]).toEqual([0.1, 1, 1, 0, 0, 0]);
  });
});
