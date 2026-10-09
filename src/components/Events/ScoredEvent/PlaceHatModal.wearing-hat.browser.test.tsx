import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

/**
 * The tile for the post already wearing this hat can't be picked. Its hat must still burst on a
 * real click like every other hat: a hat inside a disabled <button> never gets the click, because
 * the browser drops pointer clicks on a disabled button's descendants. Only a real pointer shows
 * that; a DOM `.click()` on the hat reaches it either way.
 */

const { equip, placeable } = vi.hoisted(() => ({
  equip: vi.fn(async () => undefined),
  placeable: [
    { entityType: 'Image', entityId: 500, title: null, image: null },
    { entityType: 'Image', entityId: 501, title: null, image: null },
  ],
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'event.getPlaceableContent': {
      useQuery: () => ({ data: placeable, isLoading: false, isError: false }),
    },
  }),
}));
vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));
vi.mock('~/components/Cosmetics/cosmetics.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEquipContentDecoration: () => ({ equip, isLoading: false }),
}));

import PlaceHatModal from '~/components/Events/ScoredEvent/PlaceHatModal';

type MyHat = React.ComponentProps<typeof PlaceHatModal>['hat'];
const HAT = {
  cosmeticId: 31,
  claimKey: 'claimed',
  name: 'Party Cap - Blue',
  data: { type: 'hat', event: 'birthday2026', url: 'u', team: 'Blue' },
  placedOn: { entityType: 'Image', entityId: 500, title: null, image: null },
  placedAt: null,
  movableAt: null,
  moveCooldownLeftMs: 0,
  points: 0,
  impressions: 0,
  reactions: 0,
} as unknown as MyHat;

const bursts = () =>
  document.querySelectorAll('[data-event-decoration="hat"] > span[aria-hidden]').length;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('PlaceHatModal: the tile already wearing the hat', () => {
  test('bursts confetti on a real click on its hat, and is not picked', async () => {
    renderWithProviders(<PlaceHatModal event="birthday2026" hat={HAT} myHats={[HAT]} />);
    const hat = page.getByRole('button', { name: 'Party hat', exact: true });
    await expect.element(hat).toBeVisible();
    expect(bursts()).toBe(0);

    await userEvent.click(hat);

    await expect.poll(bursts).toBe(1);
    expect(equip).not.toHaveBeenCalled();
  });

  test('still cannot be picked, while another tile can', async () => {
    renderWithProviders(<PlaceHatModal event="birthday2026" hat={HAT} myHats={[HAT]} />);
    await expect.element(page.getByText('Wearing this hat now')).toBeVisible();
    await userEvent.click(page.getByText('Wearing this hat now'));
    expect(equip).not.toHaveBeenCalled();
    // The only pickable tile: a button that is not a hat.
    const tiles = [...document.querySelectorAll('button:not([data-event-decoration])')].filter(
      (b) => b.closest('.mantine-Modal-body') && !b.closest('.mantine-Modal-header')
    );
    expect(tiles).toHaveLength(1);
    await userEvent.click(page.elementLocator(tiles[0]));
    await expect.poll(() => equip.mock.calls.length).toBe(1);
    expect(equip).toHaveBeenCalledWith(
      expect.objectContaining({ equippedToType: 'Image', equippedToId: 501 })
    );
  });
});
