import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { ServiceRequestModal } from '~/components/CreatorShop/Services/deals/ServiceRequestModal';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import { queryClient } from '~/utils/trpc';
import { installTrpcWire, renderWithTrpcWire } from '../../../../../test/trpcWireHarness';

// A buyer short on Buzz who buys more from the hold button must land back on the popup with
// nothing held: the hold is placed only by a second, deliberate click.

const viewer = { id: 990000001, username: 'buyer' };
const flags = { buzz: true, canBuyBuzz: true, creatorServicesNext: true, isBlue: true };
const offering = {
  id: 990000002,
  title: 'Portrait commission',
  description: 'One painted portrait of your character.',
  price: 2500,
  deliveryDays: 5,
  revisionsIncluded: 1,
  licensePreset: null,
  licenseCustomText: null,
  licenseAllowResale: false,
  requestForm: null,
  requestFormVersion: 0,
};

let wire: ReturnType<typeof installTrpcWire> | undefined;
afterEach(() => wire?.restore());

async function openToHold(balance: number) {
  wire = installTrpcWire({
    'buzz.getBuzzAccount': () => ({ yellow: balance, green: 0, blue: 0, red: 0 }),
    'creatorServiceDeal.request': () => ({ id: 990000003 }),
  });
  dialogStore.trigger({
    component: ServiceRequestModal,
    props: { offering, sellerUsername: 'seller', sellerId: 990000004 },
  });
  renderWithTrpcWire(<></>, { viewer, flags });

  await page.getByLabelText('What do you want?').fill('A portrait of my character, please.');
  // Found by place, not name, so a hold button that lost its props is still the one clicked.
  const hold = page.getByRole('dialog').getByRole('button').last();
  await expect.element(hold).toBeEnabled();
  await expect.poll(() => wire?.callsTo('buzz.getBuzzAccount').length).toBeGreaterThan(0);
  return { calls: wire, hold };
}

describe('ServiceRequestModal hold button', () => {
  test('a buyer with enough Buzz sends the request on the click', async () => {
    const { calls, hold } = await openToHold(5000);
    await expect.element(hold).toHaveAccessibleName('Hold 2,500 Buzz and send request');
    await hold.click();
    await expect.poll(() => calls.callsTo('creatorServiceDeal.request')).toHaveLength(1);
    expect(calls.callsTo('creatorServiceDeal.request')[0]).toMatchObject({
      type: 'mutation',
      input: { offeringId: offering.id, expectedPrice: 2500 },
    });
  });

  test('a short buyer who completes the Buzz purchase has no request sent for them', async () => {
    const { calls, hold } = await openToHold(100);
    await hold.click();
    await expect
      .poll(() => useDialogStore.getState().dialogs.some((d) => d.id === 'buy-buzz-modal'))
      .toBe(true);
    const buyBuzz = useDialogStore.getState().dialogs.find((d) => d.id === 'buy-buzz-modal');
    expect(buyBuzz?.props).toMatchObject({ minBuzzAmount: 2400 });

    // The purchase itself runs in Stripe or Paddle; what returns to the app is this callback.
    (buyBuzz?.props as { onPurchaseSuccess?: () => void }).onPurchaseSuccess?.();
    // A fence, not the app's own refresh: the test refetches the balance after the callback, so a
    // request the callback started is on the wire before that answer lands.
    const balanceReads = calls.callsTo('buzz.getBuzzAccount').length;
    await queryClient.refetchQueries({ queryKey: [['buzz', 'getBuzzAccount']] });
    expect(calls.callsTo('buzz.getBuzzAccount').length).toBe(balanceReads + 1);

    expect(calls.callsTo('creatorServiceDeal.request')).toHaveLength(0);
  });
});
