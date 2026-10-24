import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type * as NotificationUtils from '~/utils/notifications';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * The "Allow stickers on" chips on the account card, and the one property no
 * server test can see: **what a save sends for `mediaTypes`.**
 *
 * `settings` replaces the stored object, so a save that leaves a key out deletes
 * it. A slider move that forgot `mediaTypes` would quietly reopen videos for a
 * creator who had closed them, and every server-side assertion would stay true.
 */

const { mutate, spaces } = vi.hoisted(() => ({
  mutate: vi.fn(),
  spaces: { value: [] as Record<string, unknown>[] },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ stickerPlacement: true }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationUtils>()),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/components/Notifications/notifications.utils', () => ({
  useQueryNotificationsCount: () => ({ pendingPlacements: 0 }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // A proxy, naming only what this file measures: what the card reads for the
  // account's space, and the save it sends.
  trpc: makeTrpcProxy(
    {
      'placement.getPriceRange': {
        useQuery: () => ({ data: { min: 50, max: 500, freeSlotCap: 4, score: 0, tier: 'free' } }),
      },
      'placement.getMySpaces': {
        useQuery: () => ({ data: spaces.value, isPending: false, isError: false }),
      },
      'placement.setSpace': { useMutation: () => ({ mutate, isPending: false }) },
    },
    { useUtils: () => ({ placement: { invalidate: vi.fn() } }) }
  ),
}));

import { PlacementSpaceSection } from '~/components/Account/PlacementSpaceSection';

const givenSpace = (settings: Record<string, unknown>, mode = 'review') => {
  spaces.value = [{ entityType: 'user', entityId: 7, mode, price: 100, freeSlots: null, settings }];
};

const lastPayload = () => mutate.mock.calls[mutate.mock.calls.length - 1][0];

beforeEach(() => {
  vi.clearAllMocks();
  spaces.value = [];
});

describe('PlacementSpaceSection — the images/videos chips', () => {
  test('both are on for an account that never set them, and a save sends no key', async () => {
    renderWithProviders(<PlacementSpaceSection />);

    await expect.element(page.getByRole('checkbox', { name: 'Images' })).toBeChecked();
    await expect.element(page.getByRole('checkbox', { name: 'Videos' })).toBeChecked();

    await userEvent.click(page.getByText('Accept all'));

    expect(lastPayload().settings).not.toHaveProperty('mediaTypes');
  });

  test('unticking Videos saves images only', async () => {
    renderWithProviders(<PlacementSpaceSection />);

    await userEvent.click(page.getByText('Videos'));

    expect(lastPayload().settings.mediaTypes).toEqual(['image']);
  });

  // The property the file exists for: an unrelated control must carry the choice.
  test('an unrelated save keeps a stored choice', async () => {
    givenSpace({ maxScale: 0.1, mediaTypes: ['image'] });
    renderWithProviders(<PlacementSpaceSection />);

    await expect.element(page.getByRole('checkbox', { name: 'Videos' })).not.toBeChecked();
    await userEvent.click(page.getByText('Accept all'));

    expect(lastPayload().settings).toEqual({ maxScale: 0.1, mediaTypes: ['image'] });
  });

  test('ticking Videos back on drops the key rather than storing both', async () => {
    givenSpace({ mediaTypes: ['image'] });
    renderWithProviders(<PlacementSpaceSection />);

    await userEvent.click(page.getByText('Videos'));

    expect(lastPayload().settings).not.toHaveProperty('mediaTypes');
  });

  test('the last chip left on cannot be turned off', async () => {
    givenSpace({ mediaTypes: ['video'] });
    renderWithProviders(<PlacementSpaceSection />);

    await expect.element(page.getByRole('checkbox', { name: 'Videos' })).toBeDisabled();
    await userEvent.click(page.getByText('Videos'), { force: true });

    expect(mutate).not.toHaveBeenCalled();
  });

  test('the chips are hidden when stickers are off', async () => {
    givenSpace({}, 'off');
    renderWithProviders(<PlacementSpaceSection />);

    await expect.element(page.getByText('No stickers')).toBeVisible();
    expect(page.getByText('Allow stickers on').elements()).toHaveLength(0);
  });
});
