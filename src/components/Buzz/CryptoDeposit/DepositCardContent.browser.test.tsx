import { page } from '@vitest/browser/context';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

import type * as TrpcMod from '~/utils/trpc';
import { DepositCardContent } from '~/components/Buzz/CryptoDeposit/DepositCardContent';

// A depositor on the Solana chain can pick SOL or USDC (chain-config targets usdcsol). The
// "send X on the Solana network only" warning is the last thing they read before sending, so it
// must name the token they actually picked.

let selectedTicker = 'usdc';

vi.mock('~/components/Buzz/CryptoDeposit/CurrencySelector', () => ({
  useCurrencySelection: () => ({
    selectedTicker,
    selectedCode: '',
    selectedGroup: null,
    selectedNetwork: null,
  }),
  CurrencyBadges: () => null,
  MinDepositInfo: () => null,
  MinDepositWarning: () => null,
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'nowPayments.getBuzzConversionRate': {
      useQuery: () => ({ data: undefined, isFetching: false }),
    },
  }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ isModerator: false }) }));
vi.mock('~/components/UserSettings/hooks', () => ({
  useCurrentUserSettings: () => ({}),
  useMutateUserSettings: () => ({ mutate: vi.fn() }),
}));
vi.mock('~/components/Buzz/CryptoDeposit/BulkBonusNotice', () => ({ BulkBonusNotice: () => null }));
vi.mock('~/components/Buzz/CryptoDeposit/FiatMenu', () => ({ FiatMenu: () => null }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

function renderCard(chain: string, ticker: string) {
  selectedTicker = ticker;
  renderWithProviders(
    <DepositCardContent
      depositAddress="So11111111111111111111111111111111111111112"
      error={null}
      loading={false}
      onRetry={vi.fn()}
      chain={chain}
      onCurrencySelect={vi.fn()}
    />
  );
}

describe('DepositCardContent Solana network warning', () => {
  it('tells a USDC depositor to send USDC, never SOL', async () => {
    renderCard('sol', 'usdc');
    await expect.element(page.getByText(/Solana network/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Send SOL/);
    expect(document.body.textContent).toMatch(/Send USDC on the/);
    expect(document.body.textContent).toMatch(/USDC\s+sent via Base is not supported/);
  });

  it('tells a SOL depositor to send SOL', async () => {
    renderCard('sol', 'sol');
    await expect.element(page.getByText(/Solana network/)).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/Send SOL on the/);
    expect(document.body.textContent).toMatch(/SOL\s+sent via Base is not supported/);
  });

  it('leaves the other chains alone', async () => {
    renderCard('btc', 'btc');
    await expect.element(page.getByText(/Bitcoin network/)).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/Send BTC on the/);
    expect(document.body.textContent).not.toMatch(/Solana/);
  });
});
