import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_TIMING,
  applyEnrichment,
  carryOver,
  decideRefresh,
  deltaSince,
  mergeDelta,
  needsEnrichment,
  snapshotWarnings,
  type Snapshot,
  type TicketRecord,
} from './snapshot';

const NOW = 1_800_000_000_000;
const T = SNAPSHOT_TIMING;

const rec = (id: number, over: Partial<TicketRecord> = {}): TicketRecord => ({
  id: String(id),
  subject: `s${id}`,
  status: 2,
  cfFeature: null,
  tags: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  ...over,
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  tickets: [],
  syncedAt: NOW - 10_000,
  attemptedAt: NOW - 10_000,
  fullAt: NOW - 10_000,
  needsFull: false,
  readWarnings: [],
  routerFailed: false,
  lastError: null,
  ...over,
});

describe('decideRefresh', () => {
  it('builds in full when there is no snapshot', () => {
    expect(decideRefresh(null, NOW)).toBe('full');
  });

  it('does nothing inside the minimum interval', () => {
    expect(decideRefresh(snap({ attemptedAt: NOW - (T.deltaMinMs - 1) }), NOW)).toBe('none');
  });

  it('asks for a delta once the minimum interval has passed', () => {
    expect(decideRefresh(snap({ attemptedAt: NOW - T.deltaMinMs }), NOW)).toBe('delta');
  });

  it('rebuilds in full once the last full build is old', () => {
    expect(
      decideRefresh(snap({ fullAt: NOW - T.fullRebuildMs, attemptedAt: NOW - T.deltaMinMs }), NOW)
    ).toBe('full');
  });

  it('rebuilds in full when the last successful sync is too old for a delta', () => {
    const s = snap({ syncedAt: NOW - T.deltaMaxAgeMs, attemptedAt: NOW - T.deltaMinMs });
    expect(decideRefresh(s, NOW)).toBe('full');
  });

  it('throttles on the last attempt, so a failing refresh is not retried on every read', () => {
    const failing = snap({ syncedAt: NOW - 3_600_000, attemptedAt: NOW - 1000, lastError: 'x' });
    expect(decideRefresh(failing, NOW)).toBe('none');
  });

  it('waits out the retry interval before a full rebuild a partial read asked for, and skips deltas meanwhile', () => {
    const s = snap({ needsFull: true, attemptedAt: NOW - T.deltaMinMs });
    expect(decideRefresh(s, NOW)).toBe('none');
    expect(decideRefresh({ ...s, attemptedAt: NOW - T.fullRetryMs }, NOW)).toBe('full');
  });
});

describe('deltaSince', () => {
  it('reaches back by the overlap', () => {
    expect(deltaSince(NOW)).toBe(new Date(NOW - T.deltaOverlapMs).toISOString());
  });
});

describe('mergeDelta', () => {
  it('updates a changed ticket in place', () => {
    const out = mergeDelta([rec(1), rec(2)], [{ ...rec(2), status: 3, subject: 'new' }]);
    expect(out.find((t) => t.id === '2')).toMatchObject({ status: 3, subject: 'new' });
    expect(out).toHaveLength(2);
  });

  it('drops a ticket that is now resolved or closed', () => {
    const out = mergeDelta(
      [rec(1), rec(2), rec(3)],
      [rec(2, { status: 4 }), rec(3, { status: 5 })]
    );
    expect(out.map((t) => t.id)).toEqual(['1']);
  });

  it('drops a ticket flagged deleted or spam', () => {
    const out = mergeDelta([rec(1), rec(2)], [{ ...rec(2), gone: true }]);
    expect(out.map((t) => t.id)).toEqual(['1']);
  });

  it('adds a new live ticket and ignores a new one that is already closed', () => {
    const out = mergeDelta([rec(1)], [rec(9), rec(10, { status: 5 })]);
    expect(out.map((t) => t.id).sort()).toEqual(['1', '9']);
  });

  it('ignores a status this app does not list as live', () => {
    expect(mergeDelta([], [rec(1, { status: 77 })])).toEqual([]);
  });

  it('keeps the newest copy when the overlap reads one ticket twice', () => {
    const older = rec(5, { updatedAt: '2026-10-02T00:00:00Z', subject: 'old' });
    const newer = rec(5, { updatedAt: '2026-10-03T00:00:00Z', subject: 'new' });
    expect(mergeDelta([], [newer, older])).toEqual([newer]);
    expect(mergeDelta([], [older, newer])).toEqual([newer]);
  });

  it('keeps enrichment and requester details the delta does not carry', () => {
    const before = rec(1, {
      routerTopic: 'nsfw-moderation',
      civitaiUserId: 42,
      enrichedAt: 5,
      requesterName: 'Ann',
      requesterEmail: 'a@x.test',
    });
    const [after] = mergeDelta([before], [rec(1, { status: 3 })]);
    expect(after).toMatchObject({
      status: 3,
      routerTopic: 'nsfw-moderation',
      civitaiUserId: 42,
      requesterName: 'Ann',
      requesterEmail: 'a@x.test',
    });
  });

  it('prefers requester details the delta does carry', () => {
    const [after] = mergeDelta(
      [rec(1, { requesterName: 'Old' })],
      [rec(1, { requesterName: 'New' })]
    );
    expect(after.requesterName).toBe('New');
  });

  it('does not mutate its input', () => {
    const current = [rec(1), rec(2)];
    const frozen = structuredClone(current);
    mergeDelta(current, [rec(2, { status: 5 })]);
    expect(current).toEqual(frozen);
  });
});

describe('carryOver', () => {
  it('copies enrichment and requester details from the previous snapshot by id', () => {
    const prev = [
      rec(1, { routerTopic: 't', civitaiUserId: 3, enrichedAt: 9, requesterName: 'Ann' }),
    ];
    const out = carryOver(prev, [rec(1), rec(2)]);
    expect(out[0]).toMatchObject({
      routerTopic: 't',
      civitaiUserId: 3,
      enrichedAt: 9,
      requesterName: 'Ann',
    });
    expect(out[1]).toEqual(rec(2));
  });

  it('takes status, tags and subject from the fresh read', () => {
    const out = carryOver(
      [rec(1, { status: 2, tags: ['a'] })],
      [rec(1, { status: 3, tags: ['b'] })]
    );
    expect(out[0]).toMatchObject({ status: 3, tags: ['b'] });
  });
});

describe('needsEnrichment', () => {
  it('is true for a ticket never asked about', () => {
    expect(needsEnrichment(rec(1), NOW)).toBe(true);
  });

  it('is false for an enriched ticket that has a topic or a feature', () => {
    expect(needsEnrichment(rec(1, { enrichedAt: NOW, routerTopic: 't' }), NOW)).toBe(false);
    expect(
      needsEnrichment(
        rec(1, { enrichedAt: NOW - 99 * T.enrichRetryMs, routerTopic: null, cfFeature: 'X' }),
        NOW
      )
    ).toBe(false);
  });

  it('retries a ticket with no feature and no topic only after the retry interval', () => {
    const asked = (ago: number) => rec(1, { enrichedAt: NOW - ago, routerTopic: null });
    expect(needsEnrichment(asked(T.enrichRetryMs - 1), NOW)).toBe(false);
    expect(needsEnrichment(asked(T.enrichRetryMs), NOW)).toBe(true);
  });
});

describe('applyEnrichment', () => {
  it('records what the router knew, and its silence as null', () => {
    expect(applyEnrichment(rec(1), { topic: 't', civitaiUserId: 7 }, NOW)).toMatchObject({
      routerTopic: 't',
      civitaiUserId: 7,
      enrichedAt: NOW,
    });
    expect(applyEnrichment(rec(1), undefined, NOW)).toMatchObject({
      routerTopic: null,
      civitaiUserId: null,
      enrichedAt: NOW,
    });
  });
});

describe('snapshotWarnings', () => {
  it('is empty for a healthy snapshot', () => {
    expect(snapshotWarnings(snap(), NOW)).toEqual([]);
  });

  it('carries the warnings of a short full read', () => {
    expect(snapshotWarnings(snap({ readWarnings: ['Showing 3 of 9'] }), NOW)).toContain(
      'Showing 3 of 9'
    );
  });

  it('says the router could not be read', () => {
    expect(snapshotWarnings(snap({ routerFailed: true }), NOW).join(' ')).toMatch(/router/i);
  });

  it('says the data is out of date only when a refresh failed and the data is old', () => {
    const failedRecently = snap({ lastError: 'boom', syncedAt: NOW - T.staleWarnMs + 1 });
    expect(snapshotWarnings(failedRecently, NOW)).toEqual([]);
    const failedAndOld = snap({ lastError: 'boom', syncedAt: NOW - T.staleWarnMs });
    const [warning] = snapshotWarnings(failedAndOld, NOW);
    expect(warning).toMatch(/out of date/i);
    expect(warning).toContain('boom');
  });

  it('does not call old data stale when nothing failed', () => {
    expect(snapshotWarnings(snap({ syncedAt: NOW - 3_600_000 }), NOW)).toEqual([]);
  });
});
