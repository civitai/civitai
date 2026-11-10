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
    left?: boolean;
    ownerOff?: boolean;
    mode: string;
    cap?: number;
    nextAt?: Date | null;
  },
  stickers: [] as unknown[],
  nextCursor: null as { createdAt: string; id: string } | null,
  drawCeiling: undefined as number | undefined,
  fetchPage: vi.fn(),
  place: vi.fn(),
  info: vi.fn(),
  optIn: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  user: { id: 1 } as { id: number } | null,
  mine: null as unknown,
  noHats: false,
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
            data: {
              stickers: h.stickers,
              mine: h.mine,
              nextCursor: h.nextCursor,
              drawCeiling: h.drawCeiling,
            },
            refetch: async () => undefined,
          }),
        },
        'hatTurf.getMyStickerHats': {
          useQuery: () => ({
            data: h.noHats
              ? []
              : [
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
import {
  HatTurfDetailBadge,
  HatTurfDetailControls,
} from '~/components/HatTurf/detail/HatTurfDetailControls';
import { HatTurfDetailLayer } from '~/components/HatTurf/detail/HatTurfDetailLayer';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';

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
          {/* ImageDetail2's action row: Tip is a 36px (`h-9`) badge and the turf badge follows it. */}
          <div className="flex items-center gap-1" data-testid="action-row">
            <span className="inline-flex h-9 min-w-9 items-center rounded-full" data-testid="tip">
              Tip
            </span>
            <HatTurfDetailBadge imageId={9} />
          </div>
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
  h.stock = { available: 3, optedIn: true, mode: 'live', cap: 50, nextAt: null };
  h.stickers = [
    sticker(1, 'blue', 0.3, 0.3),
    sticker(2, 'pink', 0.6, 0.5),
    sticker(3, 'blue', 0.5, 0.7),
  ];
  h.user = { id: 1 };
  h.mine = null;
  h.noHats = false;
  h.place.mockReset();
  h.info.mockReset();
  h.nextCursor = null;
  h.drawCeiling = undefined;
  h.fetchPage.mockReset();
  h.optIn.mockReset();
  localStorage.clear();
  useHatTurfStore.setState({ cosmeticId: null, showHats: true });
});
afterEach(() => cleanup());

/** The sticker editor's commit on the draft hat (the panel has its own "Place hat"). */
const placeHatButton = () =>
  vi.waitFor(() => {
    const button = [...(q('hat-turf-draft')?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Place hat'
    );
    if (!button) throw new Error('no Place hat on the draft');
    return button;
  });

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

  test('not joined: a closed image still invites', async () => {
    h.stock = { available: 3, optedIn: false, mode: 'live' };
    render({ open: { 9: false } });
    await vi.waitFor(() => expect(q('hat-turf-detail-invite')).not.toBeNull());
    click(text(/^Join$/));
    expect(h.optIn).toHaveBeenCalledWith(
      { event: 'birthday2026', optedIn: true },
      expect.anything()
    );
  });

  test('joined: a closed image has no hat to place, and the card says so', async () => {
    render({ open: { 9: false } });
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    expect(q('hat-turf-detail-hat')).toBeNull();
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() =>
      expect(q('hat-turf-detail-closed')?.textContent).toBe("Hats can't go on this picture")
    );
  });

  test('joined: an open image says nothing about being closed', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-panel')).not.toBeNull());
    expect(q('hat-turf-detail-closed')).toBeNull();
  });

  // Justin's call: a leaver is not invited again unprompted; the hat button still rejoins.
  test('left: no invite opens by itself, and pressing the hat opens it', async () => {
    h.stock = { available: 3, optedIn: false, left: true, mode: 'live' };
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 300));
    expect(q('hat-turf-detail-invite')).toBeNull();
    click(q('hat-turf-detail-hat'));
    await vi.waitFor(() => expect(q('hat-turf-detail-invite')).not.toBeNull());
  });

  // Join refuses a user who keeps Hat Turf off their images, so inviting them is a dead end.
  test('owner-off, never joined: no invite opens by itself', async () => {
    h.stock = { available: 3, optedIn: false, ownerOff: true, mode: 'live' };
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 300));
    expect(q('hat-turf-detail-invite')).toBeNull();
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

  test('the hat button is a full circle', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    const button = q('hat-turf-detail-hat')!;
    const b = button.getBoundingClientRect();
    expect(b.width).toBe(30);
    expect(b.height).toBe(30);
    // A rounded square still takes a tap 2px in from its corner; a circle does not.
    expect(document.elementFromPoint(b.left + 2, b.bottom - 2)?.closest('button')).not.toBe(button);
    expect(document.elementFromPoint(b.left + 15, b.top + 15)?.closest('button')).toBe(button);
  });

  test('one press drops the active hat as a draft; the check places it from image-detail', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    click(q('hat-turf-detail-hat'));
    click(await placeHatButton());
    expect(h.place).toHaveBeenCalledTimes(1);
    const input = h.place.mock.calls[0][0];
    expect(input).toMatchObject({ imageId: 9, source: 'image-detail', cosmeticId: 11 });
  });

  test('after a save the placer sees their hat at once, without waiting for any reread', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    click(q('hat-turf-detail-hat'));
    click(await placeHatButton());
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

  test('Change opens the hats tray; picking one makes it your hat and brings the panel back', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-panel-hat')?.textContent).toBe('Party Cap'));
    click(q('hat-turf-panel-change'));
    await vi.waitFor(() => expect(q('hat-turf-tray')).not.toBeNull());
    const tiles = () => [...q('hat-turf-tray')!.querySelectorAll('button[aria-pressed]')];
    // Recently used first, as the query returns them; "Most used" re-sorts.
    expect(tiles().map((b) => b.textContent)).toEqual(['Party Cap', 'Top Hat']);
    click(tiles()[1]);
    await vi.waitFor(() => expect(q('hat-turf-panel-hat')?.textContent).toBe('Top Hat'));
    await vi.waitFor(() => expect(q('hat-turf-tray')).toBeNull());
    expect(useHatTurfStore.getState().cosmeticId).toBe(12);
    // Picking chooses the hat; it does not drop one on the image.
    expect(q('hat-turf-draft')).toBeNull();
  });

  test('the tray searches your hats by name', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-panel-change')).not.toBeNull());
    click(q('hat-turf-panel-change'));
    await vi.waitFor(() => expect(q('hat-turf-tray')).not.toBeNull());
    await userEvent.fill(page.getByLabelText('Search your hats'), 'top');
    await vi.waitFor(() =>
      expect(
        [...q('hat-turf-tray')!.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent)
      ).toEqual(['Top Hat'])
    );
  });

  test('with no hats to place, Place hat is off and drops nothing', async () => {
    h.noHats = true;
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-panel-place')).not.toBeNull());
    expect(q('hat-turf-panel')!.textContent).toContain('You have no hats to place yet.');
    expect((q('hat-turf-panel-place') as HTMLButtonElement).disabled).toBe(true);
    click(q('hat-turf-panel-place'));
    await new Promise((r) => setTimeout(r, 100));
    expect(q('hat-turf-draft')).toBeNull();
  });

  test('Place hat in the panel drops your hat as a draft and closes the panel', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-panel-place')).not.toBeNull());
    click(q('hat-turf-panel-place'));
    await vi.waitFor(() => expect(q('hat-turf-draft')).not.toBeNull());
    await vi.waitFor(() => expect(q('hat-turf-panel')).toBeNull());
  });

  test('the panel shows every team count, hats left of the cap, and Show hats off hides only the hats', async () => {
    render();
    await vi.waitFor(() => expect(hats().length).toBe(3));
    expect(q('hat-turf-detail-hat')).not.toBeNull();
    expect(q('hat-turf-gear')).not.toBeNull();
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-panel')).not.toBeNull());
    expect(q('hat-turf-panel-standings')!.textContent).toMatch(/Blue leads.*Blue 2.*Pink 1/);
    expect(q('hat-turf-panel-supply')!.textContent).toMatch(/^3 of 50 hats/);
    click(q('hat-turf-panel')!.querySelector('input[type="checkbox"]'));
    await vi.waitFor(() => expect(hats().length).toBe(0));
    // The game stays: standings, the hat button and its gear.
    expect(q('hat-turf-detail-badge')).not.toBeNull();
    expect(q('hat-turf-detail-hat')).not.toBeNull();
    expect(q('hat-turf-gear')).not.toBeNull();

    click(q('hat-turf-panel')!.querySelector('input[type="checkbox"]'));
    await vi.waitFor(() => expect(hats().length).toBe(3));
  });

  test('the next hat counts down', async () => {
    h.stock = { ...h.stock, nextAt: new Date(Date.now() + (7 * 60 + 12) * 1000) };
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() =>
      expect(q('hat-turf-panel-refill')?.textContent).toMatch(/^\+1 in 7m 1[12]s$/)
    );
  });

  test('a full supply says Full', async () => {
    h.stock = { ...h.stock, available: 50, nextAt: null };
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-panel-refill')?.textContent).toBe('Full'));
  });

  test('a protected image says which team holds it', async () => {
    render({
      images: {
        9: {
          shown: { blue: 2, pink: 12 },
          counted: { blue: 2, pink: 12 },
          leader: 'pink',
          leaderCosmeticId: 11,
          hatted: true,
          hattedTeam: 'blue',
        },
      },
    });
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() =>
      expect(q('hat-turf-panel-standings')?.textContent).toMatch(/^Pink leads · Blue holds/)
    );
    expect(q('hat-turf-panel-standings')!.textContent).toContain(
      "The owner's hat protects it for Blue until it comes off."
    );
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
    // Faded, not greyed: every team's hat still shows its colour.
    for (const hat of hats())
      expect(getComputedStyle(hat).filter).not.toMatch(/grayscale|saturate/);
    // The badge's lock says it; the picture carries no "would take it" pill any more.
    expect(q('hat-turf-badge-lock')).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/would take it/);
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

  // Deliberate (event owner's call, 2026-11-04): the hat's own art is the sticker, with no team cone
  // and no corner marker on the viewer's own.
  test("a hat draws as its own art, the viewer's own included, with no cone or marker", async () => {
    const art = { url: 'blue-cap-art', canvas: [128, 160], bounds: [24, 40, 104, 150] };
    h.stickers = [{ ...sticker(1, 'blue', 0.3, 0.3), art }];
    h.mine = { ...sticker(99, 'blue', 0.6, 0.6), userId: 1, art };
    render({}, 900);
    await vi.waitFor(() => expect(hats().length).toBe(2));
    for (const hat of hats()) {
      const box = hat.querySelector<HTMLElement>('[data-testid="hat-turf-art"]')!;
      expect(box.querySelector('img')?.getAttribute('src')).toContain('blue-cap-art');
      expect(hat.querySelector('svg')).toBeNull();
      expect(hat.querySelector('i')).toBeNull();
      // A square at the hat's drawn size, with the visible art centred in it.
      const { width, height } = box.getBoundingClientRect();
      expect(width).toBeGreaterThan(40);
      expect(height).toBeCloseTo(width, 0);
    }
  });

  test('the art is scaled and centred by its visible pixels, and art with no fit fills most of the square', async () => {
    const canvas = [128, 160];
    const bounds = [24, 40, 104, 150];
    h.stickers = [
      { ...sticker(1, 'blue', 0.3, 0.3), art: { url: 'cap-art', canvas, bounds } },
      { ...sticker(2, 'blue', 0.6, 0.6), art: { url: 'beanie-art' } },
    ];
    render({}, 900);
    await vi.waitFor(() => expect(hats().length).toBe(2));
    const rects = (url: string) => {
      const box = [...document.body.querySelectorAll('[data-testid="hat-turf-art"]')].find((el) =>
        el.querySelector('img')?.getAttribute('src')?.includes(url)
      )!;
      return [box.getBoundingClientRect(), box.querySelector('img')!.getBoundingClientRect()];
    };

    const [square, img] = rects('cap-art');
    const [cw, ch] = canvas;
    const [l, t, r, b] = bounds;
    const visible = {
      left: img.left + (img.width * l) / cw,
      right: img.left + (img.width * r) / cw,
      top: img.top + (img.height * t) / ch,
      bottom: img.top + (img.height * b) / ch,
    };
    // The visible pixels, not the canvas, sit in the middle of the square.
    expect((visible.left + visible.right) / 2).toBeCloseTo(square.left + square.width / 2, 0);
    expect((visible.top + visible.bottom) / 2).toBeCloseTo(square.top + square.height / 2, 0);
    // They cover 62% of the side by area (the hat previews' rule), so every design reads the same size.
    const side = Math.sqrt((visible.right - visible.left) * (visible.bottom - visible.top));
    expect(side / square.width).toBeCloseTo(0.62, 2);

    const [plainSquare, plainImg] = rects('beanie-art');
    expect(plainImg.width / plainSquare.width).toBeCloseTo(0.8, 2);
    expect(plainImg.height / plainSquare.height).toBeCloseTo(1, 2);
    expect((plainImg.left - plainSquare.left) / plainSquare.width).toBeCloseTo(0.1, 2);
    expect(plainImg.top - plainSquare.top).toBeCloseTo(0, 0);
  });

  test('a hat whose art is unknown falls back to the team cone', async () => {
    h.stickers = [sticker(1, 'blue', 0.3, 0.3)];
    render({}, 900);
    await vi.waitFor(() => expect(hats().length).toBe(1));
    expect(hats()[0].querySelector('svg')).not.toBeNull();
    expect(hats()[0].querySelector('img')).toBeNull();
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

  describe('the draw ceiling (Justin: "Ceiling at 24 now", changeable by the turf override)', () => {
    const page = (from: number, team: string, n = 12) =>
      Array.from({ length: n }, (_, i) => sticker(from + i, team, 0.05 + (i % 6) * 0.15, 0.2));
    const cursor = (id: number) => ({ createdAt: '2026-11-03T00:00:00.000Z', id: String(id) });
    const OWN = { ...sticker(999, 'yellow', 0.5, 0.5), userId: 1 };
    const summary = (shown: Record<string, number>) => ({
      images: {
        9: {
          shown,
          counted: shown,
          leader: 'blue',
          leaderCosmeticId: 11,
          hatted: false,
          hattedTeam: null,
        },
      },
    });
    const forty = summary({ blue: 20, pink: 20 });
    // The summary counts every live hat on the image, the viewer's own included.
    const fortyAndMine = summary({ blue: 20, pink: 20, yellow: 1 });
    const chip = () => q('hat-turf-more');
    const more = async (calls: number) => {
      click(chip());
      await vi.waitFor(() => expect(h.fetchPage).toHaveBeenCalledTimes(calls));
    };

    test('stops drawing and offering more at 24; the rest is a plain count', async () => {
      h.stickers = page(1, 'blue');
      h.nextCursor = cursor(12);
      h.fetchPage.mockResolvedValue({
        stickers: page(100, 'pink'),
        mine: null,
        nextCursor: cursor(112),
      });
      h.drawCeiling = 24;
      render(forty);
      await vi.waitFor(() => expect(chip()!.textContent).toContain('+28 more'));
      expect(chip()!.tagName).toBe('BUTTON');
      await more(1);
      await vi.waitFor(() => expect(hats().length).toBe(24));
      // Another page exists (nextCursor), yet nothing offers it: the chip is a count, not a button.
      expect(chip()!.tagName).toBe('DIV');
      expect(chip()!.textContent).toBe('+16');
    });

    test('a ceiling that is not a whole number of pages stops part way into a page', async () => {
      h.stickers = page(1, 'blue');
      h.nextCursor = cursor(12);
      h.fetchPage
        .mockResolvedValueOnce({ stickers: page(100, 'pink'), mine: null, nextCursor: cursor(112) })
        .mockResolvedValueOnce({
          stickers: page(200, 'blue'),
          mine: null,
          nextCursor: cursor(212),
        });
      h.drawCeiling = 30;
      render(forty);
      await vi.waitFor(() => expect(chip()!.textContent).toContain('+28 more'));
      await more(1);
      await vi.waitFor(() => expect(chip()!.textContent).toContain('+16 more'));
      await more(2);
      await vi.waitFor(() => expect(hats().length).toBe(30));
      expect(chip()!.tagName).toBe('DIV');
      expect(chip()!.textContent).toBe('+10');
    });

    // Keep: the viewer's own hat is drawn on top of the ceiling, never cut by it (24 + yours).
    test("the viewer's own hat is drawn on top of the ceiling", async () => {
      h.mine = OWN;
      h.stickers = page(1, 'blue');
      h.nextCursor = cursor(12);
      h.fetchPage.mockResolvedValue({
        stickers: page(100, 'pink'),
        mine: null,
        nextCursor: cursor(112),
      });
      h.drawCeiling = 24;
      render(fortyAndMine);
      await vi.waitFor(() => expect(chip()!.textContent).toContain('+28 more'));
      await more(1);
      await vi.waitFor(() => expect(hats().length).toBe(25));
      expect(
        document.querySelectorAll('[data-testid="hat-turf-hat"][data-team="yellow"]')
      ).toHaveLength(1);
      expect(chip()!.textContent).toBe('+16');
    });

    test('an own hat among the newest still leaves room for 24 others', async () => {
      h.mine = OWN;
      // The first page holds the viewer's own hat, so it brings 11 others, not 12.
      h.stickers = [...page(1, 'blue', 11), OWN];
      h.nextCursor = cursor(12);
      h.fetchPage
        .mockResolvedValueOnce({ stickers: page(100, 'pink'), mine: null, nextCursor: cursor(112) })
        .mockResolvedValueOnce({
          stickers: page(200, 'pink'),
          mine: null,
          nextCursor: cursor(212),
        });
      h.drawCeiling = 24;
      render(fortyAndMine);
      await vi.waitFor(() => expect(hats().length).toBe(12));
      await more(1);
      // 23 others loaded: one short of the ceiling, so more is still offered.
      await vi.waitFor(() => expect(hats().length).toBe(24));
      expect(chip()!.tagName).toBe('BUTTON');
      await more(2);
      await vi.waitFor(() => expect(hats().length).toBe(25));
      expect(chip()!.tagName).toBe('DIV');
      expect(chip()!.textContent).toBe('+16');
    });
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

  test('the hat button fills the 30px reaction row and is square', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    expect(q('hat-turf-detail-controls')!.getBoundingClientRect().height).toBeLessThanOrEqual(30);
    const hat = q('hat-turf-detail-hat')!.getBoundingClientRect();
    expect(hat.height).toBe(30);
    expect(hat.width).toBe(30);
    expect(q('hat-turf-gear')).not.toBeNull();
  });

  test('the badge sits in the action row at Tip’s height, off the picture', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-badge')).not.toBeNull());
    const tip = q('tip')!.getBoundingClientRect();
    const badge = q('hat-turf-detail-badge')!.getBoundingClientRect();
    expect(tip.height).toBe(36);
    expect(badge.height).toBe(tip.height);
    expect(q('hat-turf-badge')!.getBoundingClientRect().height).toBe(tip.height);
    const picture = document.body.querySelector('img')!.getBoundingClientRect();
    expect(badge.bottom <= picture.top || badge.top >= picture.bottom).toBe(true);
    // The picture's layer draws no badge of its own.
    expect(document.body.querySelectorAll('[data-testid="hat-turf-detail-badge"]')).toHaveLength(1);
  });

  test('the hat button’s gear opens the same panel as the badge', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
    click(q('hat-turf-gear'));
    await vi.waitFor(() => expect(q('hat-turf-panel-standings')).not.toBeNull());
    expect(q('hat-turf-panel-hat')!.textContent).toBe('Party Cap');
  });

  // Turf is seen by joined players only. A viewer who
  // has not joined gets the hat button as their way in, and no standings, counts or hats.
  // The same picture with hats and counts on it, joined and not: the joined row is the positive
  // control that hats and the badge do draw from this context.
  test.each([
    { who: 'joined', optedIn: true },
    { who: 'not joined', optedIn: false },
  ])('$who: hats and the standings badge only when joined', async ({ optedIn }) => {
    h.stock = { available: 3, optedIn, mode: 'live' };
    localStorage.setItem('hat-turf-detail-invite-dismissed', String(Date.now()));
    render({ joined: optedIn, stickers: { 9: h.stickers as never } });
    await vi.waitFor(() => expect(q('hat-turf-detail-hat')).not.toBeNull());
    if (optedIn) {
      await vi.waitFor(() => expect(hats().length).toBe(3));
      expect(q('hat-turf-detail-badge')).not.toBeNull();
      return;
    }
    // Give a gate that let them through the time the joined row needs to draw them.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hats().length).toBe(0);
    expect(q('hat-turf-layer')).toBeNull();
    expect(q('hat-turf-detail-badge')).toBeNull();
    click(q('hat-turf-detail-hat'));
    await vi.waitFor(() => expect(text(/^Join$/)).toBeTruthy());
  });

  test('signed out: no hats, but the badge stays and its card invites them to sign in and join', async () => {
    h.user = null;
    // The provider hands a viewer who has not joined no counts (images empty) but the stickers stay
    // in reach of the layer, which must still not draw them.
    render({ joined: false, images: {}, stickers: { 9: h.stickers as never } });
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    expect(q('action-row')!.contains(q('hat-turf-detail-badge'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hats().length).toBe(0);
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-detail-empty')).not.toBeNull());
    expect(q('hat-turf-detail-empty')!.textContent).toMatch(/Sign in and join Hat Turf/);
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

  // Product decision (2026-11-06): leaving is on the event page and in account settings only.
  // Don't add a Leave button back to this popover without that decision being reversed.
  test('the hat popover has no Leave', async () => {
    render();
    await vi.waitFor(() => expect(q('hat-turf-detail-badge')).not.toBeNull());
    click(q('hat-turf-detail-badge'));
    await vi.waitFor(() => expect(q('hat-turf-panel')?.textContent).toMatch(/Show hats/));
    expect(q('hat-turf-panel')!.textContent).not.toMatch(/Leave/);
  });
});
