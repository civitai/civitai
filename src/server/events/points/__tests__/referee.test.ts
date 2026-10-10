import { describe, expect, it, vi } from 'vitest';
import type { EventScoring } from '~/server/events/base.event';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

const { changedHats, refereeQueryParams, refereeTotals, refereeWindow } = await import(
  '~/server/events/points/referee'
);
const { eventPointsRefereeSql, eventPointsRefereeUsersSql } = await import(
  '~/server/events/points/referee.sql'
);
const { diffHats } = await import('~/server/events/points/sync');
const { liveBucketRange } = await import('~/server/events/points/read');
const { LIVE_BUCKET_MS, liveBucket, hatTopicId, parseHatField, hatField } = await import(
  '~/server/events/points/keys'
);

const scoring = {
  capPerActorPerOwnerPerDay: 50,
  types: {},
  newAccountDays: 7,
  finalizeAfterMs: 0,
} satisfies EventScoring;
const EVENT = {
  name: 'e',
  previewFrom: new Date('2026-10-09T00:00:00.000Z'),
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  endDate: new Date('2026-12-01T00:00:00.000Z'),
  scoring,
};

describe('refereeWindow', () => {
  it('settles to a bucket boundary at least ten minutes back', () => {
    const { start, cut } = refereeWindow(EVENT, 'live', new Date('2026-11-05T12:07:30.000Z'));
    expect(start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(cut.toISOString()).toBe('2026-11-05T11:55:00.000Z');
  });

  it('never settles past the season end: the preview stops at the launch', () => {
    const { start, cut } = refereeWindow(EVENT, 'preview', new Date('2026-11-01T03:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-10-09T00:00:00.000Z');
    expect(cut.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('never settles adds past the end of the live season either', () => {
    const { cut } = refereeWindow(EVENT, 'live', new Date('2026-12-01T12:07:00.000Z'));
    expect(cut.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  // The winner is decided on the totals after the finalize window, so a takedown inside it must
  // still net out its add, whichever day that add was on.
  describe('after the live season ends', () => {
    const FINALIZING = { ...EVENT, scoring: { ...scoring, finalizeAfterMs: 24 * 60 * 60 * 1000 } };

    it('settles removals on through the finalize window, and recomputes the whole season', () => {
      const { cut, removeCut, recomputeFrom } = refereeWindow(
        FINALIZING,
        'live',
        new Date('2026-12-01T12:07:00.000Z')
      );
      expect(cut.toISOString()).toBe('2026-12-01T00:00:00.000Z');
      expect(removeCut.toISOString()).toBe('2026-12-01T11:55:00.000Z');
      expect(recomputeFrom.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    });

    it('stops settling removals when the finalize window closes', () => {
      const { removeCut } = refereeWindow(FINALIZING, 'live', new Date('2026-12-02T05:00:00.000Z'));
      expect(removeCut.toISOString()).toBe('2026-12-02T00:00:00.000Z');
    });

    it('recomputes the whole season from the first run whose cut reaches the end', () => {
      const at = (time: string) => refereeWindow(FINALIZING, 'live', new Date(time)).recomputeFrom;
      expect(at('2026-12-01T00:10:00.000Z').toISOString()).toBe('2026-11-01T00:00:00.000Z');
      expect(at('2026-11-30T23:59:00.000Z').toISOString()).toBe('2026-11-29T00:00:00.000Z');
    });
  });

  it('settles removals to the same cut as adds while the season runs, and in the preview', () => {
    const live = refereeWindow(EVENT, 'live', new Date('2026-11-05T12:07:30.000Z'));
    expect(live.removeCut).toEqual(live.cut);
    const preview = refereeWindow(
      { ...EVENT, scoring: { ...scoring, finalizeAfterMs: 24 * 60 * 60 * 1000 } },
      'preview',
      new Date('2026-11-01T03:00:00.000Z')
    );
    expect(preview.removeCut.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('recomputes from the day before the cut on an hourly run', () => {
    const { recomputeFrom } = refereeWindow(EVENT, 'live', new Date('2026-11-05T12:07:30.000Z'));
    expect(recomputeFrom.toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });

  // Just after midnight the cut is still on the previous day, so that day is the one still open.
  it('counts back from the cut’s day, not the clock’s, just after midnight', () => {
    const { cut, recomputeFrom } = refereeWindow(
      EVENT,
      'live',
      new Date('2026-11-05T00:07:00.000Z')
    );
    expect(cut.toISOString()).toBe('2026-11-04T23:55:00.000Z');
    expect(recomputeFrom.toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  it('recomputes the whole season on the 03:00 UTC run, and only then', () => {
    const at = (time: string) => refereeWindow(EVENT, 'live', new Date(time)).recomputeFrom;
    expect(at('2026-11-05T03:07:00.000Z').toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(at('2026-11-05T02:59:00.000Z').toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(at('2026-11-05T04:00:00.000Z').toISOString()).toBe('2026-11-04T00:00:00.000Z');
  });

  it('never recomputes from before the season start', () => {
    const { recomputeFrom } = refereeWindow(EVENT, 'live', new Date('2026-11-01T12:07:00.000Z'));
    expect(recomputeFrom.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});

// The queries' placeholders are only checked by a real ClickHouse (scripts/check-event-points-sql.mjs),
// so a param renamed on one side would otherwise surface only in production.
describe('referee query params', () => {
  const placeholders = (sql: string) =>
    new Map([...sql.matchAll(/\{(\w+):([^}]+)\}/g)].map(([, name, type]) => [name, type]));
  const params = refereeQueryParams(
    {
      ...EVENT,
      scoring: { ...scoring, types: { view: { weight: 1, once: 'day', entities: ['Image'] } } },
    },
    refereeWindow(EVENT, 'live', new Date('2026-11-05T12:07:30.000Z')),
    undefined,
    { hidden: [1], newAccountMinId: 2 }
  );

  it('supplies every placeholder in both queries, and nothing neither uses', () => {
    const used = new Map([
      ...placeholders(eventPointsRefereeSql),
      ...placeholders(eventPointsRefereeUsersSql),
    ]);
    expect(used.size).toBeGreaterThan(5);
    for (const sql of [eventPointsRefereeSql, eventPointsRefereeUsersSql])
      for (const name of placeholders(sql).keys()) expect(Object.keys(params)).toContain(name);
    expect(Object.keys(params).sort()).toEqual([...used.keys()].sort());
  });

  it('weights each type by its live weight, aligned with the types, falling back to the config', () => {
    const withWeights = refereeQueryParams(
      {
        ...EVENT,
        scoring: {
          ...scoring,
          types: {
            view: { weight: 1, once: 'day', entities: ['Image'] },
            reaction: { weight: 5, once: 'event', entities: ['Image'] },
            remix: { weight: 25, once: 'event', entities: ['Image'] },
          },
        },
      },
      refereeWindow(EVENT, 'live', new Date('2026-11-05T12:07:30.000Z')),
      { reaction: '7', remix: 'not a number' },
      { hidden: [], newAccountMinId: 1 }
    );
    expect(withWeights.types).toEqual(['view', 'reaction', 'remix']);
    expect(withWeights.weights).toEqual([1, 7, 25]);
    expect(withWeights.dailyTypes).toEqual(['view']);
  });

  it('bounds adds by the cut and removals by the removal cut', () => {
    const finalizing = { ...EVENT, scoring: { ...scoring, finalizeAfterMs: 24 * 60 * 60 * 1000 } };
    const ended = refereeQueryParams(
      finalizing,
      refereeWindow(finalizing, 'live', new Date('2026-12-01T12:07:00.000Z')),
      undefined,
      { hidden: [], newAccountMinId: 1 }
    );
    expect({ cut: ended.cut, removeCut: ended.removeCut }).toEqual({
      cut: '2026-12-01 00:00:00.000',
      removeCut: '2026-12-01 11:55:00.000',
    });
  });

  it('passes an array for every Array placeholder and a scalar otherwise', () => {
    const used = new Map([
      ...placeholders(eventPointsRefereeSql),
      ...placeholders(eventPointsRefereeUsersSql),
    ]);
    for (const [name, type] of used)
      expect([name, Array.isArray(params[name as keyof typeof params])]).toEqual([
        name,
        type.startsWith('Array('),
      ]);
  });
});

const row = (
  userId: number,
  cosmeticId: number,
  team: string,
  points: number,
  day = '2026-11-02'
) => ({
  day,
  userId,
  cosmeticId,
  claimKey: 'claimed',
  team,
  points,
  views: 0,
  reactions: 0,
  comments: 0,
  stickers: 0,
  remixes: 0,
  modelLikes: 0,
});

describe('refereeTotals', () => {
  it('sums every day of the season per hat, team and owner', () => {
    const totals = refereeTotals([
      row(1, 7, 'Yellow', 10),
      row(1, 7, 'Yellow', 5, '2026-11-03'),
      row(1, 8, 'Yellow', 2),
      row(2, 7, 'Blue', 4),
    ]);
    expect(Object.fromEntries(totals.hat)).toEqual({
      '1:7:claimed': 15,
      '1:8:claimed': 2,
      '2:7:claimed': 4,
    });
    expect(Object.fromEntries(totals.team)).toEqual({ Yellow: 17, Blue: 4 });
    expect(Object.fromEntries(totals.owner)).toEqual({ '1': 17, '2': 4 });
  });
});

describe('changedHats', () => {
  it('reports a hat only when the shown total moves: settled live points already shown are not a change', () => {
    const changed = changedHats(
      { a: '10', b: '5', gone: '3' },
      [{ a: '5' }, { c: '1' }],
      new Map([
        ['a', 15], // 10 + 5 live: same total, no push
        ['b', 4], // a correction down
        ['c', 1], // came from live only, unchanged
      ])
    );
    expect(changed.sort()).toEqual(['b', 'gone']);
  });
});

describe('diffHats', () => {
  it('writes new and changed hats and removes the ones that came off', () => {
    expect(
      diffHats(
        { 'Image:1': 'a', 'Image:2': 'b', 'Image:3': 'c' },
        new Map([
          ['Image:1', 'a'],
          ['Image:2', 'B'],
          ['Image:4', 'd'],
        ])
      )
    ).toEqual({
      set: [
        ['Image:2', 'B'],
        ['Image:4', 'd'],
      ],
      remove: ['Image:3'],
    });
  });
});

describe('liveBucketRange', () => {
  it('reads from the cut to now, and at most three hours back when the referee has stopped', () => {
    const now = new Date('2026-11-05T12:07:00.000Z');
    const last = liveBucket(now);
    expect(liveBucketRange(last - 2, now)).toEqual([last - 2, last - 1, last]);
    const stale = liveBucketRange(0, now);
    expect(stale).toHaveLength((3 * 60 * 60 * 1000) / LIVE_BUCKET_MS);
    expect(stale.at(-1)).toBe(last);
  });
});

describe('hat ids', () => {
  const hat = { ownerId: 1, cosmeticId: 2, claimKey: 'cosmetic-purchase-v2-abc:def' };
  it('round-trips a claim key that contains colons', () => {
    expect(parseHatField(hatField(hat))).toEqual(hat);
  });
  it('gives a hat an opaque public id that does not contain its claim key', () => {
    const id = hatTopicId(hat);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain('abc');
    expect(hatTopicId({ ...hat, claimKey: 'claimed' })).not.toBe(id);
  });
});
