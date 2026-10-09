import { describe, expect, it, vi } from 'vitest';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_STARTS_AT,
} from '~/shared/constants/birthday2026.constants';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

const { daysToScore, scorePoints } = await import(
  '~/server/events/scoring/cosmetic-placement.service'
);

const HOUR = 60 * 60 * 1000;
const event = { startDate: BIRTHDAY_2026_STARTS_AT, endDate: BIRTHDAY_2026_ENDS_AT };
const iso = (days: ReturnType<typeof daysToScore>) =>
  days.map((d) => [d.day.toISOString(), d.start.toISOString(), d.end.toISOString()]);

describe('daysToScore', () => {
  it('is empty before the event starts', () => {
    expect(daysToScore(event, new Date(BIRTHDAY_2026_STARTS_AT.getTime() - 1))).toEqual([]);
  });

  it('clips the first day to the start instant (08:00Z), not UTC midnight', () => {
    const now = new Date('2026-11-11T10:00:00.000Z');
    expect(iso(daysToScore(event, now))).toEqual([
      ['2026-11-11T00:00:00.000Z', '2026-11-11T08:00:00.000Z', '2026-11-11T10:00:00.000Z'],
    ]);
  });

  it('rescores yesterday until six hours after it ended, then only today', () => {
    expect(iso(daysToScore(event, new Date('2026-11-15T05:59:59.000Z')))).toEqual([
      ['2026-11-14T00:00:00.000Z', '2026-11-14T00:00:00.000Z', '2026-11-15T00:00:00.000Z'],
      ['2026-11-15T00:00:00.000Z', '2026-11-15T00:00:00.000Z', '2026-11-15T05:59:59.000Z'],
    ]);
    expect(iso(daysToScore(event, new Date('2026-11-15T06:00:00.000Z')))).toEqual([
      ['2026-11-15T00:00:00.000Z', '2026-11-15T00:00:00.000Z', '2026-11-15T06:00:00.000Z'],
    ]);
  });

  it('never scores past ENDS_AT (exclusive)', () => {
    const now = new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 3 * HOUR);
    expect(iso(daysToScore(event, now))).toEqual([
      ['2026-11-26T00:00:00.000Z', '2026-11-26T00:00:00.000Z', '2026-11-26T08:00:00.000Z'],
    ]);
    expect(daysToScore(event, new Date('2026-11-27T07:00:00.000Z'))).toEqual([]);
  });
});

describe('scorePoints', () => {
  it('adds signed and capped signed-out impressions to weighted reactions', () => {
    expect(
      scorePoints({ impressions: 7, anonImpressions: 3, reactions: 2 }, { reactionWeight: 10 })
    ).toBe(30);
  });
});
