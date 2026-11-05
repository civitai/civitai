import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

import '~/styles/globals.css';

const h = vi.hoisted(() => ({
  stock: { available: 3, optedIn: true, mode: 'live' } as {
    available: number;
    optedIn: boolean;
    mode: string;
  } | null,
  playable: true,
  user: { id: 1 } as { id: number } | null,
  set: vi.fn(),
  flags: { hatTurfImageDetail: true } as Record<string, boolean>,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy(
      {
        'hatTurf.getStock': { useQuery: () => ({ data: h.stock }) },
        'hatTurf.setOptIn': { useMutation: () => ({ isPending: false, mutate: h.set }) },
      },
      {
        useUtils: () => ({
          hatTurf: { getStock: { invalidate: vi.fn() }, getSummaries: { invalidate: vi.fn() } },
        }),
      }
    ),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.user }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => h.flags,
}));
vi.mock('~/components/Decorations/usePlayableEventDecoration', () => ({
  usePlayableEventDecoration: (_type: string, enabled = true) =>
    enabled && h.playable ? { event: 'birthday2026' } : undefined,
}));

import { HatTurfSetting } from '~/components/Account/HatTurfSetting';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { renderWithProviders } from '../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';

const toggle = () =>
  document.body.querySelector<HTMLInputElement>('[data-testid="hat-turf-setting-toggle"]');

beforeEach(() => {
  h.stock = { available: 3, optedIn: true, mode: 'live' };
  h.playable = true;
  h.user = { id: 1 };
  h.set.mockReset();
  h.flags = { hatTurfImageDetail: true };
  useHatTurfStore.setState({ showHats: true });
});
afterEach(() => cleanup());

describe('Take part in Hat Turf, in profile settings', () => {
  test('reads the opt-in and writes the change, under the #hat-turf anchor', async () => {
    renderWithProviders(<HatTurfSetting />);
    await vi.waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()!.checked).toBe(true);
    expect(toggle()!.closest('section')!.id).toBe('hat-turf');
    toggle()!.click();
    expect(h.set).toHaveBeenCalledWith({ event: 'birthday2026', optedIn: false });
  });

  test('off when the viewer has not joined', async () => {
    h.stock = { available: 3, optedIn: false, mode: 'live' };
    renderWithProviders(<HatTurfSetting />);
    await vi.waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()!.checked).toBe(false);
    toggle()!.click();
    expect(h.set).toHaveBeenCalledWith({ event: 'birthday2026', optedIn: true });
  });

  test.each([
    ['Hat Turf is off', () => (h.stock = { available: 0, optedIn: false, mode: 'off' })],
    ['the event is not playable', () => (h.playable = false)],
    ['signed out', () => (h.user = null)],
  ])('not shown when %s', async (_, given) => {
    given();
    renderWithProviders(
      <div data-testid="root">
        <HatTurfSetting />
      </div>
    );
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="root"]')).not.toBeNull()
    );
    expect(toggle()).toBeNull();
  });
});

// A viewer with Hat Turf on feeds only has no image page switch, so settings must carry it
// whenever any surface runs.
describe('Show hats, in profile settings', () => {
  const showHats = () =>
    document.body.querySelector<HTMLInputElement>('[data-testid="hat-turf-show-hats-setting"]');

  test.each([
    ['feeds only', { hatTurfFeedCard: true }],
    ['the image page only', { hatTurfImageDetail: true }],
  ])('with Hat Turf on %s, hats switched off can be switched back on', async (_, flags) => {
    h.flags = flags;
    useHatTurfStore.setState({ showHats: false });
    renderWithProviders(<HatTurfSetting />);
    await vi.waitFor(() => expect(showHats()).not.toBeNull());
    expect(showHats()!.checked).toBe(false);
    showHats()!.click();
    await vi.waitFor(() => expect(useHatTurfStore.getState().showHats).toBe(true));
  });
});
