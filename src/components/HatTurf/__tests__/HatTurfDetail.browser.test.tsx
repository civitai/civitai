import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as Notifications from '~/utils/notifications';
import type * as TrackUtilsModule from '~/components/TrackView/track.utils';

import '~/styles/globals.css';

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ hatTurfImageDetail: true }),
}));
const h = vi.hoisted(() => ({
  stock: { available: 3, optedIn: true, mode: 'live' } as {
    available: number;
    optedIn: boolean;
    mode: string;
  },
  stickers: [] as unknown[],
  nextCursor: null as { createdAt: string; id: string } | null,
  fetchPage: vi.fn(),
  place: vi.fn(),
  info: vi.fn(),
  optIn: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  user: { id: 1 } as { id: number } | null,
  mine: null as unknown,
  trackAction: vi.fn<(data: unknown) => Promise<void>>(async () => undefined),
}));
vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtilsModule>()),
  useTrackEvent: () => ({ trackAction: h.trackAction }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy(
      {
        'hatTurf.getStock': { useQuery: () => ({ data: h.stock }) },
        'hatTurf.getImageStickers': {
          useQuery: () => ({
            data: { stickers: h.stickers, mine: h.mine, nextCursor: h.nextCursor },
            refetch: async () => undefined,
          }),
        },
        'hatTurf.getMyStickerHats': {
          useQuery: () => ({
            data: [
              { cosmeticId: 11, usageCount: 3, lastUsedAt: null },
              { cosmeticId: 12, usageCount: 9, lastUsedAt: null },
            ],
          }),
        },
        'event.getMyHats': {
          useQuery: () => ({
            data: [
              { cosmeticId: 11, name: 'Party Cap' },
              { cosmeticId: 12, name: 'Top Hat' },
            ],
          }),
        },
        'hatTurf.place': { useMutation: () => ({ isPending: false, mutate: h.place }) },
        'hatTurf.setOptIn': { useMutation: () => ({ isPending: false, mutate: h.optIn }) },
      },
      {
        useUtils: () => ({
          hatTurf: {
            getStock: { invalidate: h.invalidate },
            getSummaries: { invalidate: h.invalidate },
            getStickersForImages: { invalidate: h.invalidate },
            getImageStickers: { invalidate: h.invalidate, fetch: h.fetchPage },
          },
        }),
      }
    ),
  };
});
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showInfoNotification: h.info,
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (h.user ? { ...h.user, isModerator: false } : null),
}));
vi.mock('~/components/Signals/SignalsProvider', () => ({
  useSignalTopic: () => undefined,
  useSignalConnection: () => undefined,
}));

import { HatTurfCardProvider } from '~/components/HatTurf/HatTurfCardProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import type { TurfSummaries } from '~/components/HatTurf/TurfSummaryProvider';
import { HatTurfDetailControls } from '~/components/HatTurf/detail/HatTurfDetailControls';
import { HatTurfDetailLayer } from '~/components/HatTurf/detail/HatTurfDetailLayer';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';

const sticker = (id: number, team: string, x: number, y: number) => ({
  id,
  userId: 50 + id,
  team,
  cosmeticId: 11,
  data: { x, y, scale: 0.18, rotation: 0, flip: false },
});

function render(ctx: Partial<TurfSummaries> = {}, width = 390) {
  renderWithProviders(
    <TurfSummaryContext.Provider
      value={{
        event: 'birthday2026',
        arm: null,
        team: 'blue',
        images: {
          9: {
            shown: { blue: 2, pink: 1 },
            counted: { blue: 2, pink: 1 },
            leader: 'blue',
            leaderCosmeticId: 11,
            hatted: false,
            hattedTeam: null,
          },
        },
        open: { 9: true },
        stickers: {},
        joined: h.stock.optedIn,
        watch: () => () => undefined,
        ...ctx,
      }}
    >
      <HatTurfCardProvider>
        <div style={{ width }}>
          <div style={{ position: 'relative', width, height: 300 }}>
            <img src={LOADABLE_IMAGE_DATA_URI} style={{ width: '100%', height: '100%' }} alt="" />
            <HatTurfDetailLayer imageId={9} />
          </div>
          <HatTurfDetailControls imageId={9} />
        </div>
      </HatTurfCardProvider>
    </TurfSummaryContext.Provider>
  );
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const hats = () => document.body.querySelectorAll('[data-testid="hat-turf-hat"]');
const click = (el: Element | null | undefined) => (el as HTMLElement).click();
const text = (re: RegExp) =>
  [...document.body.querySelectorAll<HTMLElement>('button')].find((b) =>
    re.test(b.textContent ?? '')
  );

beforeEach(() => {
  h.trackAction.mockClear();
  h.stock = { available: 3, optedIn: true, mode: 'live' };
  h.stickers = [
    sticker(1, 'blue', 0.3, 0.3),
    sticker(2, 'pink', 0.6, 0.5),
    sticker(3, 'blue', 0.5, 0.7),
  ];
  h.user = { id: 1 };
  h.mine = null;
  h.place.mockReset();
  h.info.mockReset();
  h.nextCursor = null;
  h.fetchPage.mockReset();
  h.optIn.mockReset();
  localStorage.clear();
  useHatTurfStore.setState({ cosmeticId: null, showHats: true });
});
afterEach(() => cleanup());

describe('Hat Turf on image detail', () => {
  test('not joined: the purple invite shows, Join turns turf on', async () => {
    h.stock = { available: 3, optedIn: false, mode: 'live' };
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-invite')).not.toBeNull());
    expect(q('hat-turf-detail-invite')!.textContent).toMatch(/join Hat Turf/i);
    click(text(/^Join$/));
    expect(h.optIn).toHaveBeenCalledWith(
      { event: 'birthday2026', optedIn: true },
      expect.anything()
    );
  });

  test('not joined: an image whose owner has not joined still invites', async () => {
    h.stock = { available: 3, optedIn: false, mode: 'live' };
    render({ open: { 9: false } });
    await vi.waitFor(() => expect(q('hat-turf-detail-invite')).not.toBeNull());
    click(text(/^Join$/));
    expect(h.optIn).toHaveBeenCalledWith(
      { event: 'birthday2026', optedIn: true },
      expect.anything()
    );
  });

  test('joined: an image whose owner has not joined has no hat to place, and the card says why', async () => {
    render({ open: { 9: false } });
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    expect(q('hat-turf-detail-hat')).toBeNull();
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() =>
      expect(q('hat-turf-detail-closed')?.textContent).toBe(
        "This creator hasn't joined Hat Turf yet"
      )
    );
  });

  test('joined: an open image says nothing about the creator', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-detail-stats')).not.toBeNull());
    expect(q('hat-turf-detail-closed')).toBeNull();
  });

  test('Not now closes the invite and records the dismissal', async () => {
    h.stock = { available: 3, optedIn: false, mode: 'live' };
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-invite')).not.toBeNull());
    click(text(/^Not now$/));
    await vi.waitFor(() => expect(q('hat-turf-detail-invite')).toBeNull());
    expect(Number(localStorage.getItem('hat-turf-detail-invite-dismissed'))).toBeGreaterThan(0);
  });

  test('a dismissal under 24 hours old keeps the invite away', async () => {
    h.stock = { available: 3, optedIn: false, mode: 'live' };
    localStorage.setItem('hat-turf-detail-invite-dismissed', String(Date.now() - 60 * 60 * 1000));
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 300));
    expect(q('hat-turf-detail-invite')).toBeNull();
  });

  test('a dismissal over 24 hours old brings the invite back', async () => {
    h.stock = { available: 3, optedIn: false, mode: 'live' };
    localStorage.setItem(
      'hat-turf-detail-invite-dismissed',
      String(Date.now() - 25 * 60 * 60 * 1000)
    );
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-invite')).not.toBeNull());
  });

  test('one press drops the active hat as a draft; the check places it from image-detail', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    click(q('hat-turf-detail-hat'));
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    click(document.body.querySelector('[aria-label^="Place hat"]'));
    expect(h.place).toHaveBeenCalledTimes(1);
    const input = h.place.mock.calls[0][0];
    expect(input).toMatchObject({ imageId: 9, source: 'image-detail', cosmeticId: 11 });
  });

  test('after a save the placer sees their hat at once, without waiting for any reread', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    click(q('hat-turf-detail-hat'));
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    click(document.body.querySelector('[aria-label^="Place hat"]'));
    // The server read (h.stickers) never changes in this test: only the mutation succeeds.
    h.place.mock.calls[0][1].onSuccess();
    await vi.waitFor(() => expect(q('hat-turf-placed')).not.toBeNull());
    expect(q('hat-turf-draft')).toBeNull();
    expect(hats().length).toBe(3);
    // A detail save is not a feed-card placement in the feed experiment's readout.
    expect(h.trackAction).not.toHaveBeenCalled();
  });

  test('own hat beyond the feed cap still reads as placed; the button refuses instead of drafting', async () => {
    // The feed's capped list (stickers: {}) does not hold the viewer's hat; getImageStickers `mine` does.
    h.mine = { ...sticker(99, 'blue', 0.4, 0.4), userId: 1 };
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    click(q('hat-turf-detail-hat'));
    await vi.waitFor(() =>
      expect(h.info).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/already on this image/) })
      )
    );
    expect(q('hat-turf-draft')).toBeNull();
  });

  test('the switcher lists hats most used first and picking one drops it', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(text(/change/)).toBeTruthy());
    click(text(/change/));
    await vi.waitFor(() => expect(q('hat-turf-detail-tray')).not.toBeNull());
    const names = [...q('hat-turf-detail-tray')!.querySelectorAll('button')].map(
      (b) => b.textContent
    );
    expect(names[0]).toContain('Top Hat');
    click(q('hat-turf-detail-tray')!.querySelectorAll('button')[0]);
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    expect(useHatTurfStore.getState().cosmeticId).toBe(12);
  });

  test('the badge card shows every team count, never supply, and Show hats hides the hats only', async () => {
    render();
    await vi.waitFor(() => expect(hats().length).toBe(3));
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-detail-stats')).not.toBeNull());
    const card = q('hat-turf-detail-stats')!;
    expect(card.textContent).toMatch(/Blue/);
    expect(card.textContent).toMatch(/Pink/);
    expect(q('hat-turf-detail-left')!.textContent).toBe('3 hats left');
    expect(card.textContent).toContain('Your supply grows during the event.');
    expect(card.textContent).not.toMatch(/refill|per hour|\/h|cap\b/i);
    click(card.querySelector('input[type="checkbox"]'));
    await vi.waitFor(() => expect(hats().length).toBe(0));
    expect(q('hat-turf-detail-badge')).not.toBeNull();
    expect(q('hat-turf-detail-stats')!.textContent).toMatch(/Blue/);
  });

  test("a hat-protected image shows its hats muted, the viewer's own included", async () => {
    h.mine = { ...sticker(99, 'blue', 0.4, 0.4), userId: 1 };
    render({
      images: {
        9: {
          shown: { pink: 3 },
          counted: { pink: 3 },
          leader: 'pink',
          leaderCosmeticId: 11,
          hatted: true,
          hattedTeam: null,
        },
      },
    });
    await vi.waitFor(() => expect(hats().length).toBe(4));
    for (const hat of hats()) expect(hat.getAttribute('data-tone')).toBe('muted');
    const opacities = new Set([...hats()].map((hat) => getComputedStyle(hat).opacity));
    expect(opacities.size).toBe(1);
    expect(Number([...opacities][0])).toBeLessThan(1);
    expect(q('hat-turf-lock')).not.toBeNull();
  });

  test("the viewer's own hat never dims when their team is behind; other trailing hats do", async () => {
    h.mine = { ...sticker(99, 'pink', 0.4, 0.4), userId: 1 };
    render();
    await vi.waitFor(() => expect(hats().length).toBe(4));
    const tones = Object.fromEntries(
      [...hats()].map((hat) => [hat.getAttribute('style'), hat.getAttribute('data-tone')])
    );
    const toneAt = (x: number, y: number) =>
      Object.entries(tones).find(([style]) => style?.includes(`left: ${x}%; top: ${y}%`))?.[1];
    expect(toneAt(40, 40)).toBe('plain');
    expect(toneAt(60, 50)).toBe('dim');
    expect(toneAt(30, 30)).toBe('lead');
  });

  test("the viewer's own-hat dot sits on the cone, not off in the hat's padding", async () => {
    h.mine = { ...sticker(99, 'blue', 0.4, 0.4), userId: 1 };
    render({}, 900);
    await vi.waitFor(() => expect(hats().length).toBe(4));
    const own = [...hats()].find((hat) => hat.querySelector('i'))!;
    const svg = own.querySelector('svg')!.getBoundingClientRect();
    const dot = own.querySelector('i')!.getBoundingClientRect();
    // The cone's bottom-right corner in TeamHat's 24-unit viewBox is (18, 17).
    const cornerX = svg.left + (svg.width * 18) / 24;
    const cornerY = svg.top + (svg.height * 17) / 24;
    expect(Math.abs(dot.left + dot.width / 2 - cornerX)).toBeLessThan(4);
    expect(Math.abs(dot.top + dot.height / 2 - cornerY)).toBeLessThan(4);
  });

  test('past the draw cap a "more" button asks for the next hats', async () => {
    h.stickers = Array.from({ length: 12 }, (_, i) => sticker(i + 1, 'blue', 0.1 + i * 0.07, 0.5));
    render({
      images: {
        9: {
          shown: { blue: 20 },
          counted: { blue: 20 },
          leader: 'blue',
          leaderCosmeticId: 11,
          hatted: false,
          hattedTeam: null,
        },
      },
    });
    await vi.waitFor(() => expect(hats().length).toBe(12));
    expect(q('hat-turf-more')!.textContent).toContain('+8');
  });

  test('"+N more" loads the next page from the cursor and draws those hats too', async () => {
    h.stickers = Array.from({ length: 12 }, (_, i) => sticker(i + 1, 'blue', 0.1 + i * 0.07, 0.5));
    h.nextCursor = { createdAt: '2026-11-03T00:00:00.000Z', id: '100' };
    h.fetchPage.mockResolvedValue({
      stickers: Array.from({ length: 8 }, (_, i) => sticker(200 + i, 'pink', 0.1 + i * 0.1, 0.2)),
      mine: null,
      nextCursor: null,
    });
    render({
      images: {
        9: {
          shown: { blue: 12, pink: 8 },
          counted: { blue: 12, pink: 8 },
          leader: 'blue',
          leaderCosmeticId: 11,
          hatted: false,
          hattedTeam: null,
        },
      },
    });
    await vi.waitFor(() => expect(q('hat-turf-more')!.textContent).toContain('+8 more'));
    click(q('hat-turf-more'));
    await vi.waitFor(() => expect(hats().length).toBe(20));
    expect(h.fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 9, before: h.nextCursor })
    );
    expect(q('hat-turf-more')).toBeNull();
  });

  // Controls render on the first commit (context and mocks are synchronous), so the not-hidden
  // rows are the positive control for the hidden ones at the same moment.
  test.each([
    { who: 'joined', optedIn: true, hidden: false },
    { who: 'not joined', optedIn: false, hidden: false },
    { who: 'joined', optedIn: true, hidden: true },
    { who: 'not joined', optedIn: false, hidden: true },
  ])(
    '$who viewer, contest entry $hidden: detail controls only off contests',
    async ({ optedIn, hidden }) => {
      h.stock = { available: 3, optedIn, mode: 'live' };
      render(hidden ? { hidden: { 9: true } } : {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(q('hat-turf-detail-controls') === null).toBe(hidden);
    }
  );

  test('the hat controls fit the 30px reaction row, standings ring included', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    expect(q('hat-turf-detail-controls')!.getBoundingClientRect().height).toBeLessThanOrEqual(30);
    expect(q('hat-turf-detail-hat')!.getBoundingClientRect().height).toBe(30);
  });

  // Deliberate (event owner's call, 2026-11-04): turf is seen by joined players only. A viewer who
  // has not joined gets the hat button as their way in, and no standings, counts or hats.
  test('not joined: no standings badge and no hats, but the hat button still joins', async () => {
    h.stock = { available: 3, optedIn: false, mode: 'live' };
    localStorage.setItem('hat-turf-detail-invite-dismissed', String(Date.now()));
    render({ joined: false });
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    expect(q('hat-turf-detail-badge')).toBeNull();
    expect(q('hat-turf-layer')).toBeNull();
    expect(hats().length).toBe(0);
    click(q('hat-turf-detail-hat'));
    await vi.waitFor(() => expect(text(/^Join$/)).toBeTruthy());
  });

  test.each([
    ['joined', { available: 3, optedIn: true }, /tap the hat button/, false],
    ['joined, out of hats', { available: 0, optedIn: true }, /out of hats for now/, false],
  ])('no hats yet, %s: the card says what to do', async (_, stock, says, joinButton) => {
    h.stock = { ...stock, mode: 'live' };
    localStorage.setItem('hat-turf-detail-invite-dismissed', String(Date.now()));
    render({ images: {} });
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-detail-empty')).not.toBeNull());
    expect(q('hat-turf-detail-empty')!.textContent).toMatch(says);
    const join = text(/^Join Hat Turf$/);
    expect(!!join).toBe(joinButton);
    if (join) {
      click(join);
      expect(h.optIn).toHaveBeenCalledWith({ event: 'birthday2026', optedIn: true });
    }
  });

  test('Leave Hat Turf turns it off', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(text(/Leave Hat Turf/)).toBeTruthy());
    click(text(/Leave Hat Turf/));
    expect(h.optIn).toHaveBeenCalledWith({ event: 'birthday2026', optedIn: false });
  });
});
