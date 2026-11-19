import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import type * as Trpc from '~/utils/trpc';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

const h = vi.hoisted(() => ({
  stock: {
    available: 3,
    optedIn: true,
    mode: 'live',
    perHour: 0.4,
    cap: 15,
    creditedPlayers: 6,
    multiplier: 1,
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'hatTurf.getStock': { useQuery: () => ({ data: h.stock }) },
      'hatTurf.setOptIn': { useMutation: () => ({ isPending: false, mutate: () => undefined }) },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ hatTurfImageDetail: true, hatTurfFeedCard: false }),
}));
vi.mock('~/components/Decorations/usePlayableEventDecoration', () => ({
  usePlayableEventDecoration: () => ({ event: 'birthday2026' }),
}));

import { HatTurfEventSection } from '~/components/Events/ScoredEvent/HatTurfEventSection';
import { renderAtViewport } from '../../../../test/geometry-setup';

afterEach(() => cleanup());

const show = async (width: number) => {
  await renderAtViewport(
    <div style={{ padding: 12 }}>
      <HatTurfEventSection event="birthday2026" team="blue" video="" />
    </div>,
    { width, height: 700 }
  );
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="hat-turf-section-stats"]')).not.toBeNull()
  );
};
const tile = (key: string) =>
  document.querySelector(`[data-testid="hat-turf-stat-${key}"]`) as HTMLElement;

describe('the Hat Turf slice\u2019s stats strip', () => {
  test('on a wide slice the tiles are equal and the strip does not stretch across it', async () => {
    await show(1100);
    const widths = ['refill', 'cap', 'scoring'].map((k) => tile(k).getBoundingClientRect().width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    const strip = document.querySelector('[data-testid="hat-turf-section-stats"]')!;
    expect(widths[0] * 3).toBeLessThanOrEqual(430);
    expect(strip.getBoundingClientRect().width).toBeGreaterThan(widths[0] * 3);
  });

  test('on a phone the slowest cadence stays on one line in an equal tile', async () => {
    await show(360);
    const widths = ['refill', 'cap', 'scoring'].map((k) => tile(k).getBoundingClientRect().width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    const value = tile('refill').querySelector('p')!;
    expect(value.textContent).toBe('2h 30m');
    expect(value.getClientRects().length).toBe(1);
    const card = document.querySelector('[data-testid="hat-turf-event-section"]')!;
    expect(tile('scoring').getBoundingClientRect().right).toBeLessThanOrEqual(
      card.getBoundingClientRect().right
    );
  });
});
