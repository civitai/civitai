import { describe, expect, it } from 'vitest';
import { visibleNavBanners } from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import {
  collapsedLine,
  eventHomeBlockCollapseId,
  eventHomeBlockDismissId,
  eventHomeBlockDisplay,
  scoredEventHomeBlockCopy,
  scoredEventHomeBlockView,
} from '~/components/HomeBlocks/scored-event-home-block.utils';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';

const START = new Date('2026-11-01T00:00:00Z');
const END = new Date('2026-12-01T00:00:00Z');
const FINAL = new Date('2026-12-02T00:00:00Z');
const DURING = new Date('2026-11-10T00:00:00Z');
const AFTER_FINAL = new Date('2026-12-05T00:00:00Z');

const data = {
  title: "Civitai's 4th Birthday",
  startDate: START,
  endDate: END,
  finalAt: FINAL,
  preview: false,
  page: { headline: 'Civitai turns 4.', headlineAccent: 'Pick up a hat.' },
};
const standings = (updatedAt: Date) => ({
  updatedAt,
  teams: [
    { team: 'Blue', rank: 1, score: 900 },
    { team: 'Pink', rank: 2, score: 900 },
  ],
});
const hat = (points: number, placed = true) => ({
  points,
  placedOn: placed ? { entityId: 1 } : undefined,
});

describe('scoredEventHomeBlockView', () => {
  it('a viewer who has not joined is asked to join', () => {
    expect(scoredEventHomeBlockView({ data, hats: [], now: DURING })).toEqual({ state: 'join' });
  });

  it('a joined viewer gets their team, its rank and what their hats earned', () => {
    const view = scoredEventHomeBlockView({
      data,
      standings: standings(DURING),
      team: 'Pink',
      hats: [hat(512), hat(0, false)],
      now: DURING,
    });
    expect(view).toEqual({
      state: 'joined',
      team: 'Pink',
      rank: 2,
      points: 512,
      shownHats: 2,
      moreHats: 0,
    });
  });

  it('shows at most three hat tiles and counts the rest', () => {
    const view = scoredEventHomeBlockView({
      data,
      team: 'Blue',
      hats: [hat(1), hat(2), hat(3), hat(4), hat(5)],
      now: DURING,
    });
    expect(view).toMatchObject({ shownHats: 3, moreHats: 2, points: 15 });
  });

  it('names the rank-1 team once a snapshot after finalAt is in, even on a tie', () => {
    expect(
      scoredEventHomeBlockView({
        data,
        standings: standings(AFTER_FINAL),
        hats: [],
        now: AFTER_FINAL,
      })
    ).toEqual({ state: 'ended', winner: 'Blue' });
  });

  it('names no winner while the result is still settling', () => {
    const settling = new Date('2026-12-01T12:00:00Z');
    expect(
      scoredEventHomeBlockView({ data, standings: standings(settling), hats: [], now: settling })
    ).toEqual({ state: 'ended', winner: undefined });
    expect(
      scoredEventHomeBlockView({ data, standings: standings(END), hats: [], now: AFTER_FINAL })
    ).toEqual({ state: 'ended', winner: undefined });
  });

  it('ends for a joined viewer too', () => {
    expect(
      scoredEventHomeBlockView({ data, team: 'Pink', hats: [], now: AFTER_FINAL })
    ).toMatchObject({ state: 'ended' });
  });
});

describe('scoredEventHomeBlockCopy', () => {
  it('reads the promo copy while the event is playable', () => {
    expect(
      scoredEventHomeBlockCopy(data, { eyebrow: 'E', title: 'T', body: 'B', cta: 'Go' })
    ).toEqual({ eyebrow: 'E', title: 'T', accent: 'Pick up a hat.', body: 'B', cta: 'Go' });
  });

  it('falls back to the page copy once the promo is gone', () => {
    expect(scoredEventHomeBlockCopy(data)).toEqual({
      eyebrow: "Civitai's 4th Birthday",
      title: 'Civitai turns 4.',
      accent: 'Pick up a hat.',
      body: undefined,
      cta: 'Open the event',
    });
  });
});

describe('collapsedLine', () => {
  it('says what matters for each state in one line', () => {
    expect(collapsedLine({ state: 'join' })).toBe('Join a team and get a free hat');
    expect(collapsedLine({ state: 'ended', winner: 'Blue' })).toBe('Team Blue won');
    expect(collapsedLine({ state: 'ended' })).toBe('Final scores are being tallied');
    expect(
      collapsedLine({
        state: 'joined',
        team: 'Pink',
        rank: 2,
        points: 1512,
        shownHats: 1,
        moreHats: 0,
      })
    ).toBe('Team Pink is #2 · your hat has earned 1,512');
    expect(
      collapsedLine({ state: 'joined', team: 'Pink', points: 3, shownHats: 3, moreHats: 1 })
    ).toBe('Team Pink · your hats have earned 3');
  });
});

describe('closing: collapse, then hide', () => {
  const strip: NavBanner = {
    id: 'event:birthday2026',
    title: 't',
    href: '/events/birthday2026',
    dismissible: true,
    priority: 0,
  };

  it('reads full, collapsed and hidden from the cookie entries', () => {
    expect(eventHomeBlockDisplay('birthday2026', [])).toBe('full');
    expect(eventHomeBlockDisplay('birthday2026', [eventHomeBlockCollapseId('birthday2026')])).toBe(
      'collapsed'
    );
    expect(
      eventHomeBlockDisplay('birthday2026', [
        eventHomeBlockCollapseId('birthday2026'),
        eventHomeBlockDismissId('birthday2026'),
      ])
    ).toBe('hidden');
    // another event's entries, and the strip's own id, change nothing
    expect(eventHomeBlockDisplay('birthday2026', ['home:event:other', strip.id])).toBe('full');
  });

  it('closing the block leaves the strip, and closing the strip leaves the block', () => {
    const ids = [eventHomeBlockCollapseId('birthday2026'), eventHomeBlockDismissId('birthday2026')];
    expect(visibleNavBanners([strip], ids)).toEqual([strip]);
    expect(visibleNavBanners([strip], [strip.id])).toEqual([]);
  });
});
