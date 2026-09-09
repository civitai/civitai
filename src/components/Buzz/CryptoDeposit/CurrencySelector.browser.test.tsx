import { page } from '@vitest/browser/context';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../../../test/component-setup';

import type { CurrencySelectionState } from '~/components/Buzz/CryptoDeposit/CurrencySelector';
import { MinDepositInfo } from '~/components/Buzz/CryptoDeposit/CurrencySelector';

// This line is the only thing between a depositor and a sub-minimum send, which NowPayments neither
// sweeps nor refunds. `fiat_equivalent` is nullish in the NowPayments response, so the fiat branch
// can be missing while the crypto amount is present — and rendering nothing after "Minimum BTC
// deposit:" reads as "no minimum" rather than as "we could not fetch it".

function state(minData: { minAmount: number | null; fiatEquivalent: number | null } | undefined) {
  return {
    selectedTicker: 'btc',
    networkLabel: null,
    loadingMin: false,
    minData,
    selectedFiat: 'usd',
    onFiatChange: vi.fn(),
  } as unknown as CurrencySelectionState;
}

describe('MinDepositInfo', () => {
  it('shows the fiat minimum when the response carries one', async () => {
    renderWithProviders(
      <MinDepositInfo state={state({ minAmount: 0.0002, fiatEquivalent: 17.44 })} />
    );
    // $17.45, not $17.44: the line ceils to the next cent, deliberately rounding a minimum UP.
    await expect.element(page.getByText('Minimum BTC deposit: $17.45 USD ▾')).toBeInTheDocument();
  });

  it('falls back to the crypto amount when fiat_equivalent is absent', async () => {
    renderWithProviders(
      <MinDepositInfo state={state({ minAmount: 0.0002, fiatEquivalent: null })} />
    );
    await expect.element(page.getByText(/Minimum BTC deposit:\s*0\.0002 BTC/)).toBeInTheDocument();
  });

  it('never renders the label with an amount-shaped gap after it', async () => {
    renderWithProviders(
      <MinDepositInfo state={state({ minAmount: null, fiatEquivalent: null })} />
    );
    await expect.element(page.getByText(/Minimum BTC deposit:\s*unavailable/)).toBeInTheDocument();
  });
});
