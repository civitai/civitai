import { page } from '@vitest/browser/context';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../../test/component-setup';

import { DepositNetworkWarning } from '~/components/Buzz/CryptoDeposit/DepositNetworkWarning';

// Customers sent USDT0 over X Layer to the USDC-on-Base address and the deposit was never credited.
// The warning must name the token and network of the currency actually selected.

const tail = (examples: string) =>
  `Transfers on any other network (for example ${examples}) won't be credited and may not be recoverable. On exchanges like OKX or Binance, check the network selector before you confirm.`;
const TAIL = tail('X Layer, BNB Chain or Ethereum');

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

  it.each([
    ['usdcsol', 'USDC', 'Solana', 'X Layer, BNB Chain or Ethereum'],
    ['usdcerc20', 'USDC', 'Ethereum', 'X Layer or BNB Chain'],
    ['usdterc20', 'USDT', 'Ethereum', 'X Layer or BNB Chain'],
    ['usdtbsc', 'USDT', 'BNB Chain', 'X Layer or Ethereum'],
    ['usdcmatic', 'USDC', 'Polygon', 'X Layer, BNB Chain or Ethereum'],
    ['usdtmatic', 'USDT', 'Polygon', 'X Layer, BNB Chain or Ethereum'],
    ['usdcarb', 'USDC', 'Arbitrum', 'X Layer, BNB Chain or Ethereum'],
    ['usdtarb', 'USDT', 'Arbitrum', 'X Layer, BNB Chain or Ethereum'],
  ])('names the right token and network for %s', async (code, token, network, examples) => {
    renderWithProviders(<DepositNetworkWarning code={code} />);
    await expect
      .element(page.getByText(`Send only ${token} on the ${network} network. ` + tail(examples)))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('deposit-network-badge'))
      .toHaveTextContent(`${token} · ${network}`);
  });

  it('names BNB Chain and drops it from the examples when NowPayments reports bsc', async () => {
    renderWithProviders(<DepositNetworkWarning code="usdtbsc" ticker="usdt" network="bsc" />);
    await expect
      .element(
        page.getByText('Send only USDT on the BNB Chain network. ' + tail('X Layer or Ethereum'))
      )
      .toBeInTheDocument();
  });

  it('places an unmapped code from the live ticker and known network', async () => {
    renderWithProviders(<DepositNetworkWarning code="ltc2" ticker="ltc" network="ltc" />);
    await expect
      .element(page.getByText('Send only LTC on the Litecoin network. ' + TAIL))
      .toBeInTheDocument();
  });

  it('shows the raw code and no network for a code it cannot place', async () => {
    renderWithProviders(<DepositNetworkWarning code="foocoinx" network="xlayer" />);
    await expect
      .element(page.getByText('Send only FOOCOINX on the network it belongs to. ' + TAIL))
      .toBeInTheDocument();
    await expect.element(page.getByTestId('deposit-network-badge')).not.toBeInTheDocument();
  });

  it.each([
    ['unmapped network', { ticker: 'foo', network: 'unknownnet' }],
    ['no ticker', { network: 'ltc' }],
  ])('falls back to the raw code with %s', async (_label, extra) => {
    renderWithProviders(<DepositNetworkWarning code="foocoinx" {...extra} />);
    await expect
      .element(page.getByText('Send only FOOCOINX on the network it belongs to. ' + TAIL))
      .toBeInTheDocument();
    await expect.element(page.getByTestId('deposit-network-badge')).not.toBeInTheDocument();
  });
});
