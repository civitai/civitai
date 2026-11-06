import { page } from '@vitest/browser/context';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../../test/component-setup';

import { DepositNetworkWarning } from '~/components/Buzz/CryptoDeposit/DepositNetworkWarning';

// Customers sent USDT0 over X Layer to the USDC-on-Base address and the deposit was never credited.
// The warning must name the token and network of the currency actually selected.

const TAIL =
  "Transfers on any other network (for example X Layer, BNB Chain or Ethereum) won't be credited and may not be recoverable. On exchanges like OKX or Binance, check the network selector before you confirm.";

describe('DepositNetworkWarning', () => {
  it('names USDC on Base for usdcbase', async () => {
    renderWithProviders(<DepositNetworkWarning code="USDCBASE" />);
    await expect
      .element(page.getByText('Send only USDC on the Base network. ' + TAIL))
      .toBeInTheDocument();
    await expect.element(page.getByText('USDC · Base')).toBeInTheDocument();
  });

  it('names USDT on Tron for usdttrc20', async () => {
    renderWithProviders(<DepositNetworkWarning code="usdttrc20" />);
    await expect
      .element(page.getByText('Send only USDT on the Tron network. ' + TAIL))
      .toBeInTheDocument();
    await expect.element(page.getByText('USDT · Tron')).toBeInTheDocument();
  });

  it('places an unmapped code from the live ticker and known network', async () => {
    renderWithProviders(<DepositNetworkWarning code="ltc" ticker="ltc" network="ltc" />);
    await expect
      .element(page.getByText('Send only LTC on the Litecoin network. ' + TAIL))
      .toBeInTheDocument();
  });

  it('shows the raw code and no network for a code it cannot place', async () => {
    renderWithProviders(<DepositNetworkWarning code="foocoinx" network="xlayer" />);
    await expect
      .element(page.getByText('Send only FOOCOINX on the network it belongs to. ' + TAIL))
      .toBeInTheDocument();
    await expect.element(page.getByText(/ · /)).not.toBeInTheDocument();
  });
});
