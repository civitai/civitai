import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcUtils from '~/utils/trpc';

// A buyer short on Buzz is sent to the purchase modal. `performTransactionOnPurchase` decides
// whether the action then runs on the back of that purchase, which for a money hold must not
// happen: the buyer clicks again once they have the Buzz.
const { trigger } = vi.hoisted(() => ({ trigger: vi.fn() }));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ buzz: true, isGreen: false, canBuyBuzz: true }),
}));
vi.mock('~/providers/AppProvider', () => ({ useServerDomains: () => ({ green: 'green.test' }) }));
vi.mock('~/hooks/useSyncAccount', () => ({ useSyncAccount: () => (url: string) => url }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger } }));
vi.mock('~/components/Buzz/useBuzz', () => ({
  useQueryBuzz: () => ({
    data: { total: 0, accounts: [{ type: 'yellow', balance: 0, purchasable: true }] },
    isLoading: false,
  }),
}));
vi.mock('~/components/Currency/useCurrencyConfig', () => ({
  useBuzzCurrencyConfig: () => ({ color: 'yellow.7' }),
}));
vi.mock('~/components/Currency/CurrencyBadge', () => ({ CurrencyBadge: () => null }));
vi.mock('../TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackAction: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('~/utils/notifications', () => ({
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));
vi.mock('~/utils/get-client-stripe', () => ({ getClientStripe: vi.fn() }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcUtils>()),
  trpc: makeTrpcProxy(
    { 'buzz.tipUser': { useMutation: () => ({ mutate: vi.fn() }) } },
    { useUtils: () => ({ buzz: { getBuzzAccount: { invalidate: vi.fn() } } }) }
  ),
}));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { BuzzTransactionButton } from './BuzzTransactionButton';

const perform = vi.fn();

const renderButton = (performTransactionOnPurchase?: boolean) =>
  renderWithProviders(
    <BuzzTransactionButton
      buzzAmount={100}
      label="Hold and send request"
      onPerformTransaction={perform}
      performTransactionOnPurchase={performTransactionOnPurchase}
    />
  );

describe('BuzzTransactionButton when the buyer is short on Buzz', () => {
  beforeEach(() => {
    trigger.mockClear();
    perform.mockClear();
  });

  test('opens the purchase modal and does not run the action, nor queue it on purchase, when performTransactionOnPurchase is false', async () => {
    renderButton(false);
    await userEvent.click(page.getByRole('button', { name: /Hold and send request/ }));

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0].props.onPurchaseSuccess).toBeUndefined();
    expect(perform).not.toHaveBeenCalled();
  });

  test('queues the action to run after the purchase by default', async () => {
    renderButton();
    await userEvent.click(page.getByRole('button', { name: /Hold and send request/ }));

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0].props.onPurchaseSuccess).toBe(perform);
    expect(perform).not.toHaveBeenCalled();
  });
});
