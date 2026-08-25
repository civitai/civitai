import { describe, it, expect } from 'vitest';
import {
  MIN_ANNOUNCEMENT_DURATION_MS,
  clampAnnouncementWindow,
} from '~/server/services/creator-announcement.service';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const at = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;

describe('clampAnnouncementWindow — the start', () => {
  it('slides a past start up to now', () => {
    const { startsAt } = clampAnnouncementWindow({
      startsAt: at('2026-08-25T11:45:00.000Z'),
      now: NOW,
    });

    expect(startsAt).toEqual(NOW);
  });

  it('leaves a future start exactly where it was', () => {
    const chosen = at('2026-08-26T09:00:00.000Z');
    const { startsAt } = clampAnnouncementWindow({ startsAt: chosen, now: NOW });

    expect(startsAt).toEqual(chosen);
  });

  it('keeps a null start null rather than pinning it to now', () => {
    // Null means "from now on" and is what the composer sends for an open-ended announcement.
    // Writing `now` instead would make the row sort above every other open-ended one forever.
    expect(clampAnnouncementWindow({ startsAt: null, now: NOW }).startsAt).toBeNull();
  });

  it('does not re-stamp a running announcement the creator did not reschedule', () => {
    // The revert this catches: dropping the `untouched` check. A typo fix on a live announcement
    // would then move its start to now and republish it to the top of every follower's feed.
    const live = at('2026-08-20T08:00:00.000Z');
    const { startsAt } = clampAnnouncementWindow({
      startsAt: live,
      previousStartsAt: live,
      now: NOW,
    });

    expect(startsAt).toEqual(live);
  });

  it('still slides when the creator moves a start to a different past time', () => {
    const { startsAt } = clampAnnouncementWindow({
      startsAt: at('2026-08-21T08:00:00.000Z'),
      previousStartsAt: at('2026-08-20T08:00:00.000Z'),
      now: NOW,
    });

    expect(startsAt).toEqual(NOW);
  });
});

describe('clampAnnouncementWindow — the end', () => {
  it('pushes an end that is before the start out to start + the minimum', () => {
    const start = at('2026-08-26T09:00:00.000Z');
    const { endsAt } = clampAnnouncementWindow({
      startsAt: start,
      endsAt: at('2026-08-25T09:00:00.000Z'),
      now: NOW,
    });

    expect(endsAt).toEqual(new Date(start.getTime() + MIN_ANNOUNCEMENT_DURATION_MS));
  });

  it('pushes an end equal to the start out by the minimum', () => {
    const start = at('2026-08-26T09:00:00.000Z');
    const { endsAt } = clampAnnouncementWindow({ startsAt: start, endsAt: start, now: NOW });

    expect(endsAt).toEqual(new Date(start.getTime() + MIN_ANNOUNCEMENT_DURATION_MS));
  });

  it('pushes an end that is under an hour after the start', () => {
    const start = at('2026-08-26T09:00:00.000Z');
    const { endsAt } = clampAnnouncementWindow({
      startsAt: start,
      endsAt: new Date(start.getTime() + 59 * 60 * 1000),
      now: NOW,
    });

    expect(endsAt).toEqual(new Date(start.getTime() + HOUR));
  });

  it('leaves an end more than an hour out alone', () => {
    const start = at('2026-08-26T09:00:00.000Z');
    const chosen = new Date(start.getTime() + 3 * HOUR);
    const { endsAt } = clampAnnouncementWindow({ startsAt: start, endsAt: chosen, now: NOW });

    expect(endsAt).toEqual(chosen);
  });

  it('keeps a null end null — an announcement with no end runs indefinitely', () => {
    expect(clampAnnouncementWindow({ startsAt: null, endsAt: null, now: NOW }).endsAt).toBeNull();
  });

  it('measures the minimum from the SLID start, not the submitted one', () => {
    // Both dates are stale by the time they arrive. Measuring from the submitted start would store
    // an end in the past, i.e. an announcement that is over before it is saved.
    const { startsAt, endsAt } = clampAnnouncementWindow({
      startsAt: at('2026-08-25T10:00:00.000Z'),
      endsAt: at('2026-08-25T10:30:00.000Z'),
      now: NOW,
    });

    expect(startsAt).toEqual(NOW);
    expect(endsAt).toEqual(new Date(NOW.getTime() + HOUR));
    expect(endsAt!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('floors a null-start announcement against now', () => {
    const { endsAt } = clampAnnouncementWindow({
      startsAt: null,
      endsAt: at('2026-08-25T12:10:00.000Z'),
      now: NOW,
    });

    expect(endsAt).toEqual(new Date(NOW.getTime() + HOUR));
  });
});

describe('the minimum duration', () => {
  it('is one hour, and the creator-studio picker mirrors this number', () => {
    expect(MIN_ANNOUNCEMENT_DURATION_MS).toBe(HOUR);
  });
});
