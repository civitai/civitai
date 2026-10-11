import { describe, expect, it } from 'vitest';
import { visibleNavBanners } from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import {
  eventHomeBlockDismissId,
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
  joinable: true,
  page: { headline: 'Civitai turns 4.' },
};
const standings = (updatedAt: Date) => ({
  updatedAt,
  teams: [
    { team: 'Blue', rank: 1, score: 900 },
    { team: 'Pink', rank: 2, score: 900 },
  ],
});

describe('scoredEventHomeBlockView', () => {
  it('a viewer who has not joined is asked to join', () => {
    expect(scoredEventHomeBlockView({ data, hats: [], now: DURING })).toEqual({ state: 'join' });
  });

  it('a joined viewer sees their team, its rank and how many hats are placed', () => {
    const view = scoredEventHomeBlockView({
      data,
      standings: standings(DURING),
      team: 'Pink',
      hats: [{ placedOn: { entityId: 1 } }, {}, { placedOn: { entityId: 2 } }],
      now: DURING,
    });
    expect(view).toEqual({
      state: 'joined',
      team: 'Pink',
      rank: 2,
      hatsPlaced: 2,
      hatsOwned: 3,
      nextHatIndex: 1,
    });
  });

  it('every hat placed leaves no hat to place next', () => {
    const view = scoredEventHomeBlockView({
      data,
      team: 'Blue',
      hats: [{ placedOn: { entityId: 1 } }],
      now: DURING,
    });
    expect(view).toMatchObject({ state: 'joined', nextHatIndex: -1 });
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
    // A snapshot from before finalAt is not the settled one, even read after it.
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
      scoredEventHomeBlockCopy(data, {
        eyebrow: 'Eyebrow',
        title: 'Promo title',
        body: 'Promo body',
        cta: 'Go',
      })
    ).toEqual({ eyebrow: 'Eyebrow', title: 'Promo title', body: 'Promo body', cta: 'Go' });
  });

  it('falls back to the headline once the promo is gone, and marks a preview', () => {
    expect(scoredEventHomeBlockCopy(data)).toEqual({
      eyebrow: undefined,
      title: 'Civitai turns 4.',
      body: undefined,
      cta: 'See the event',
    });
    expect(scoredEventHomeBlockCopy({ ...data, preview: true }).eyebrow).toBe(
      'Preview: testers and mods'
    );
  });
});

describe('the dismiss id', () => {
  const strip: NavBanner = {
    id: 'event:birthday2026',
    title: 't',
    href: '/events/birthday2026',
    dismissible: true,
    priority: 0,
  };

  it('closing the block leaves the strip, and closing the strip leaves the block', () => {
    const blockId = eventHomeBlockDismissId('birthday2026');
    expect(blockId).not.toBe(strip.id);
    expect(visibleNavBanners([strip], [blockId])).toEqual([strip]);
    // control: the strip's own id does hide it
    expect(visibleNavBanners([strip], [strip.id])).toEqual([]);
  });
});
