import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type { FlagSummary } from '~/server/events/turf/turf.service';

import '~/styles/globals.css';

/**
 * Image detail on one of today's flags: the flag badge and the flag hat button take the Hat Turf
 * badge's and hat button's places, at the same size, while every other picture keeps Hat Turf.
 */

const h = vi.hoisted(() => ({
  user: { id: 1 } as { id: number } | null,
  stock: { available: 12, optedIn: true, mode: 'live' } as Record<string, unknown>,
  summary: null as unknown,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ hatTurfImageDetail: true, flagRace: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.user }));
vi.mock('~/components/Decorations/usePlayableEventDecoration', () => ({
  usePlayableEventDecoration: () => ({ event: 'birthday2026' }),
}));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalTopic: () => undefined,
  useSignalConnection: () => undefined,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'hatTurf.getStock': { useQuery: () => ({ data: h.user ? h.stock : undefined }) },
      'hatTurf.getFlags': { useQuery: () => ({ data: h.summary }) },
      'hatTurf.getMyStickerHats': {
        useQuery: () => ({ data: h.user ? [{ cosmeticId: 11, usageCount: 1 }] : undefined }),
      },
    }),
  };
});

import { HatTurfCardProvider } from '~/components/HatTurf/HatTurfCardProvider';
import { FlagRaceContext } from '~/components/HatTurf/FlagRace/FlagRaceContext';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import type { TurfSummaries } from '~/components/HatTurf/TurfSummaryProvider';
import {
  HatTurfDetailBadge,
  HatTurfDetailControls,
} from '~/components/HatTurf/detail/HatTurfDetailControls';
import { HatTurfDetailProvider } from '~/components/HatTurf/detail/HatTurfDetailProvider';
import { renderWithProviders } from '../../../../test/component-setup';
import { page } from 'vitest/browser';

const FLAG = 7;
const TURF = 9;
// In a contest, so hidden from Hat Turf, and not a flag.
const CONTEST = 11;
const summary = (closed = false): FlagSummary => ({
  flagDayId: 1,
  closed,
  cutAt: closed ? new Date(Date.now() - 60_000) : null,
  closesAt: new Date(Date.now() + (closed ? -1_000 : 5 * 3600_000)),
  frozen: closed,
  teamPoints: closed ? { pink: 400 } : {},
  flags: [
    {
      imageId: FLAG,
      hatsByTeam: { blue: 4, pink: 7 },
      players: 6,
      pot: 400,
      winners: closed ? ['pink'] : [],
    },
  ],
});
const turf = (joined: boolean): TurfSummaries => ({
  event: 'birthday2026',
  arm: null,
  team: 'blue',
  images: {
    [TURF]: {
      shown: { blue: 2, pink: 1 },
      counted: { blue: 2, pink: 1 },
      leader: 'blue',
      leaderCosmeticId: 11,
      hatted: false,
      hattedTeam: null,
    },
  },
  // As getTurfSummaries answers: today's flags are hidden from Hat Turf (contestEntry) and not open.
  open: { [FLAG]: false, [TURF]: true, [CONTEST]: false },
  hidden: { [FLAG]: true, [CONTEST]: true },
  stickers: {},
  joined,
  watch: () => () => undefined,
});

/** A flag and a plain Hat Turf picture, each with the detail page's badge and hat button. */
function render({ closed = false, joined = true, large = false } = {}) {
  renderWithProviders(
    <FlagRaceContext.Provider value={{ event: 'birthday2026', summary: summary(closed) }}>
      <TurfSummaryContext.Provider value={turf(joined)}>
        <HatTurfCardProvider>
          {[FLAG, TURF, CONTEST].map((id) => (
            <div key={id} data-testid={`pic-${id}`} className="flex items-center gap-1">
              <HatTurfDetailBadge imageId={id} />
              <HatTurfDetailControls imageId={id} large={large} />
            </div>
          ))}
        </HatTurfCardProvider>
      </TurfSummaryContext.Provider>
    </FlagRaceContext.Provider>
  );
}

const inPic = (id: number, testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="pic-${id}"] [data-testid="${testId}"]`);
const flagFace = () => inPic(FLAG, 'flag-hat-button')?.querySelector('button') ?? null;
const turfFace = () => inPic(TURF, 'hat-turf-detail-hat');
const box = (el: HTMLElement | null) => {
  const r = el!.getBoundingClientRect();
  return { width: r.width, height: r.height };
};

beforeEach(() => {
  h.user = { id: 1 };
  h.stock = { available: 12, optedIn: true, mode: 'live' };
  h.summary = null;
});
afterEach(() => cleanup());

describe('image detail on a flag', () => {
  test('a hidden picture that is not a flag gets no hat button and no badge', async () => {
    render();
    await vi.waitFor(() => expect(flagFace()).not.toBeNull());
    expect(inPic(CONTEST, 'hat-turf-detail-controls')).toBeNull();
    expect(inPic(CONTEST, 'hat-turf-detail-badge')).toBeNull();
    expect(inPic(CONTEST, 'flag-badge')).toBeNull();
  });

  test('shows the flag badge and flag hat button; the other picture keeps Hat Turf', async () => {
    render();
    await vi.waitFor(() => expect(inPic(FLAG, 'flag-badge')).not.toBeNull());
    expect(flagFace()).not.toBeNull();
    expect(inPic(FLAG, 'hat-turf-detail-badge')).toBeNull();
    expect(inPic(FLAG, 'hat-turf-detail-hat')).toBeNull();
    expect(inPic(TURF, 'hat-turf-detail-badge')).not.toBeNull();
    expect(turfFace()).not.toBeNull();
    expect(inPic(TURF, 'flag-badge')).toBeNull();
  });

  test.each([false, true])(
    "the flag hat button is the Hat Turf one's size (phone bottom bar: %s)",
    async (large) => {
      render({ large });
      await vi.waitFor(() => expect(flagFace()).not.toBeNull());
      expect(box(turfFace()).width).toBe(large ? 36 : 30);
      expect(box(flagFace())).toEqual(box(turfFace()));
    }
  );

  test("the flag badge is the Hat Turf badge's height", async () => {
    render();
    await vi.waitFor(() => expect(inPic(FLAG, 'flag-badge')).not.toBeNull());
    expect(box(inPic(FLAG, 'flag-badge')).height).toBe(
      box(inPic(TURF, 'hat-turf-detail-badge')).height
    );
  });

  test('a signed-in viewer who has not joined still sees the flag badge', async () => {
    h.stock = { available: 0, optedIn: false, mode: 'live' };
    render({ joined: false });
    await vi.waitFor(() => expect(inPic(FLAG, 'flag-badge')).not.toBeNull());
    // Hat Turf's own badge waits for them to join.
    expect(inPic(TURF, 'hat-turf-detail-badge')).toBeNull();
  });

  test('once the race closes the badge stays and the hat button goes', async () => {
    render({ closed: true });
    await vi.waitFor(() => expect(inPic(FLAG, 'flag-badge')).not.toBeNull());
    expect(inPic(FLAG, 'flag-badge')?.getAttribute('data-closed')).toBe('true');
    expect(flagFace()).toBeNull();
  });
});

describe('the hat menu on a phone', () => {
  // The phone bottom bar puts the button near the left edge, so the menu is pushed back on screen;
  // its arrow must still point at the button.
  test('points its arrow at the hat button', async () => {
    await page.viewport(375, 700);
    render({ large: true });
    await vi.waitFor(() => expect(flagFace()).not.toBeNull());
    flagFace()!.click();
    const arrow = () =>
      document.querySelector<HTMLElement>('.mantine-Popover-dropdown .mantine-Popover-arrow');
    await vi.waitFor(() => expect(arrow()).not.toBeNull());
    await new Promise((r) => setTimeout(r, 300));
    const face = flagFace()!.getBoundingClientRect();
    const a = arrow()!.getBoundingClientRect();
    const middle = a.left + a.width / 2;
    expect(middle).toBeGreaterThanOrEqual(face.left);
    expect(middle).toBeLessThanOrEqual(face.right);
  });
});

describe('the image detail provider', () => {
  test("knows today's flags, so a flag's badge shows on the page", async () => {
    h.summary = summary();
    renderWithProviders(
      <HatTurfDetailProvider images={[{ id: FLAG, type: 'image' }]}>
        <HatTurfDetailBadge imageId={FLAG} />
      </HatTurfDetailProvider>
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="flag-badge"]')).not.toBeNull()
    );
  });
});
