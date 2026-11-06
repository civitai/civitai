import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ stickerPlacement: true }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    // Entity 1 is still loading, entity 2 has loaded with no row of its own.
    'placement.getSpaceRow': {
      useQuery: ({ entityId }: { entityId: number }) =>
        entityId === 1
          ? { data: undefined, isPending: true, isError: false }
          : { data: null, isPending: false, isError: false },
    },
  }),
}));

import { PlacementSpaceToggle } from '~/components/Sticker/PlacementSpaceToggle';

const heightOf = (testId: string) =>
  page.getByTestId(testId).element().getBoundingClientRect().height;

describe('PlacementSpaceToggle size', () => {
  test('takes the same height while the row loads as once it has loaded', async () => {
    renderWithProviders(
      <div style={{ width: 240 }}>
        <div data-testid="loading">
          <PlacementSpaceToggle level="image" entityId={1} />
        </div>
        <div data-testid="loaded">
          <PlacementSpaceToggle level="image" entityId={2} />
        </div>
      </div>
    );
    await vi.waitFor(() => expect(heightOf('loaded')).toBeGreaterThan(40));

    expect(heightOf('loading')).toBe(heightOf('loaded'));
    // Held at the same size, but not usable: a click before the row is known would write blind.
    const radios = (id: string) =>
      Array.from(page.getByTestId(id).element().querySelectorAll('input[type="radio"]'));
    expect(radios('loading').every((r) => (r as HTMLInputElement).disabled)).toBe(true);
    expect(radios('loaded').some((r) => (r as HTMLInputElement).disabled)).toBe(false);
  });
});
