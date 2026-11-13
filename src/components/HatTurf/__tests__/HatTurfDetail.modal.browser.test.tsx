import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as Notifications from '~/utils/notifications';
import type * as TrackUtilsModule from '~/components/TrackView/track.utils';

import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';

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

import { PageModal } from '~/components/Dialog/Templates/PageModal';
import { HatTurfCardProvider } from '~/components/HatTurf/HatTurfCardProvider';
import { TurfSummaryContext } from '~/components/HatTurf/TurfSummaryProvider';
import type { TurfSummaries } from '~/components/HatTurf/TurfSummaryProvider';
import { HatTurfDetailControls } from '~/components/HatTurf/detail/HatTurfDetailControls';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { renderWithProviders, LOADABLE_IMAGE_DATA_URI } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';

/**
 * The image modal (PageModal) stacks at z-index 250. "Your hats" must open above it: under it, the
 * drawer is open but covered, and only the standalone image page (after a refresh) shows it.
 */

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const byText = (re: RegExp) =>
  [...document.body.querySelectorAll<HTMLElement>('button')].find((b) =>
    re.test(b.textContent ?? '')
  );

beforeEach(() => {
  // The app declares this order in _document; the harness has to.
  if (!document.getElementById('layer-order')) {
    const style = document.createElement('style');
    style.id = 'layer-order';
    style.textContent = '@layer tailwind-preflight, theme, mantine, modules;';
    document.head.prepend(style);
  }
  h.stock = { available: 3, optedIn: true, mode: 'live' };
  h.user = { id: 1 };
  localStorage.clear();
  useHatTurfStore.setState({ cosmeticId: null, showHats: true });
});
afterEach(() => cleanup());

const isOnTop = (el: HTMLElement) => {
  const box = el.getBoundingClientRect();
  const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return el.contains(top);
};

test('in the image modal, the panel and its hats tray open on top of the modal', async () => {
  renderWithProviders(
    <PageModal opened onClose={() => undefined} fullScreen>
      <TurfSummaryContext.Provider
        value={{
          event: 'birthday2026',
          arm: null,
          team: 'blue',
          images: {
            9: {
              shown: { blue: 2 },
              counted: { blue: 2 },
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
        }}
      >
        <HatTurfCardProvider>
          <HatTurfDetailControls imageId={9} />
        </HatTurfCardProvider>
      </TurfSummaryContext.Provider>
    </PageModal>
  );
  await vi.waitFor(() => expect(q('hat-turf-gear')).not.toBeNull());
  // Positive control: the modal's own content hit-tests as on top, so a covered drawer reads false.
  await vi.waitFor(() => expect(isOnTop(q('hat-turf-gear')!)).toBe(true));
  q('hat-turf-gear')!.click();
  await vi.waitFor(() => expect(q('hat-turf-panel-change')).not.toBeNull());
  await vi.waitFor(() => expect(isOnTop(q('hat-turf-panel-change')!)).toBe(true));
  q('hat-turf-panel-change')!.click();
  await vi.waitFor(() => expect(q('hat-turf-tray')).not.toBeNull());
  const tile = q('hat-turf-tray')!.querySelector<HTMLElement>('button[aria-pressed]')!;
  await vi.waitFor(() => expect(isOnTop(tile)).toBe(true));
});
