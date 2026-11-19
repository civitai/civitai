import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as Decorations from '~/shared/constants/event-decoration.constants';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'hatTurf.getStock': {
        useQuery: () => ({
          data: { available: 3, optedIn: false, ownerOff: false, mode: 'shadow' },
        }),
      },
      'hatTurf.setOwnerOff': { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/shared/constants/event-decoration.constants', async (importOriginal) => ({
  ...(await importOriginal<typeof Decorations>()),
  getReleasedEventDecoration: () => ({ event: 'birthday2026' }),
}));
// The pane's other card reads queries of its own; what is asserted is the row beside it.
vi.mock('~/components/Account/CreatorControlsCard', () => ({
  CreatorControlsCard: () => <div>creator controls</div>,
}));
vi.mock('~/components/Account/StickerInventoryCard', () => ({ StickerInventoryCard: () => null }));

import { cleanup } from 'vitest-browser-react';
import { AccountPane } from '~/components/Account/AccountPanes';
import { searchAccountSections } from '~/components/Account/account-sections';
import { renderWithProviders } from '../../../test/component-setup';

afterEach(() => cleanup());

// Accounts on the new settings layout render panes, not the legacy SettingsCard that held this.
describe('Creator pane', () => {
  test("carries the owner's Hat Turf switch, under its own anchor", async () => {
    await renderWithProviders(<AccountPane sectionId="creator" />);
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="hat-turf-owner-toggle"]')).not.toBeNull()
    );
    expect(document.body.textContent).toContain('creator controls');
    expect(document.getElementById('hat-turf-owner')).not.toBeNull();
  });

  test('is what "Find a setting" offers for Hat Turf', () => {
    expect(searchAccountSections('Hat Turf').map((section) => section.id)).toContain('creator');
  });
});
