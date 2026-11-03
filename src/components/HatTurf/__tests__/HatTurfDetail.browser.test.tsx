import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

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
  place: vi.fn(),
  optIn: vi.fn(),
  invalidate: vi.fn(async () => undefined),
  user: { id: 1 } as { id: number } | null,
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
            data: { stickers: h.stickers, mine: null },
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
            getImageStickers: { invalidate: h.invalidate },
          },
        }),
      }
    ),
  };
});
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
        team: 'blue',
        images: {
          9: {
            shown: { blue: 2, pink: 1 },
            counted: { blue: 2, pink: 1 },
            leader: 'blue',
            leaderCosmeticId: 11,
            hatted: false,
          },
        },
        open: { 9: true },
        stickers: {},
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
const click = (el: Element | null) => (el as HTMLElement).click();
const text = (re: RegExp) =>
  [...document.body.querySelectorAll<HTMLElement>('button')].find((b) =>
    re.test(b.textContent ?? '')
  );

beforeEach(() => {
  h.stock = { available: 3, optedIn: true, mode: 'live' };
  h.stickers = [
    sticker(1, 'blue', 0.3, 0.3),
    sticker(2, 'pink', 0.6, 0.5),
    sticker(3, 'blue', 0.5, 0.7),
  ];
  h.user = { id: 1 };
  h.place.mockReset();
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

  test('a hat-protected image shows its hats muted', async () => {
    render({
      images: {
        9: {
          shown: { pink: 3 },
          counted: { pink: 3 },
          leader: 'pink',
          leaderCosmeticId: 11,
          hatted: true,
        },
      },
    });
    await vi.waitFor(() => expect(hats().length).toBe(3));
    for (const hat of hats()) expect(hat.getAttribute('data-tone')).toBe('muted');
    expect(q('hat-turf-lock')).not.toBeNull();
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
        },
      },
    });
    await vi.waitFor(() => expect(hats().length).toBe(12));
    expect(q('hat-turf-more')!.textContent).toContain('+8');
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
