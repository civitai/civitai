import { Badge, Group, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { getKnownNetworkDisplayName } from '~/server/common/chain-config';

export type DepositTokenNetwork = { token: string; network: string };

/** NowPayments pay_currency codes whose token and network we state outright. */
const PAY_CURRENCY_TOKEN_NETWORK: Record<string, DepositTokenNetwork> = {
  usdcbase: { token: 'USDC', network: 'Base' },
  usdcsol: { token: 'USDC', network: 'Solana' },
  usdcerc20: { token: 'USDC', network: 'Ethereum' },
  usdterc20: { token: 'USDT', network: 'Ethereum' },
  usdttrc20: { token: 'USDT', network: 'Tron' },
  usdtbsc: { token: 'USDT', network: 'BNB Chain' },
  usdcmatic: { token: 'USDC', network: 'Polygon' },
  usdtmatic: { token: 'USDT', network: 'Polygon' },
  usdcarb: { token: 'USDC', network: 'Arbitrum' },
  usdtarb: { token: 'USDT', network: 'Arbitrum' },
};

/**
 * Token and network for a NowPayments pay_currency code. Returns null for a code we cannot place,
 * so the caller shows the raw code instead of a guessed network.
 */
export function getDepositTokenNetwork({
  code,
  ticker,
  network,
}: {
  code: string;
  ticker?: string | null;
  network?: string | null;
}): DepositTokenNetwork | null {
  // NowPayments' own ticker/network wins; the static map covers the window before the list loads.
  const networkName = network ? getKnownNetworkDisplayName(network) : undefined;
  if (ticker && networkName)
    return {
      token: ticker.toUpperCase(),
      network: networkName === 'BSC' ? 'BNB Chain' : networkName,
    };
  return PAY_CURRENCY_TOKEN_NETWORK[code.toLowerCase()] ?? null;
}

const EXAMPLE_NETWORKS = ['X Layer', 'BNB Chain', 'Ethereum'];

/** The example networks minus the one the user picked, so the text never calls that network unsupported. */
export function getExampleNetworks(selected?: string): string {
  const others = EXAMPLE_NETWORKS.filter((n) => n !== selected);
  return others.length > 1 ? `${others.slice(0, -1).join(', ')} or ${others.at(-1)}` : others[0];
}

function getTail(selected?: string) {
  return `Transfers on any other network (for example ${getExampleNetworks(
    selected
  )}) won't be credited and may not be recoverable. On exchanges like OKX or Binance, check the network selector before you confirm.`;
}

export function DepositNetworkWarning({
  code,
  ticker,
  network,
  chain,
}: {
  code: string;
  ticker?: string | null;
  network?: string | null;
  /** The address's chain: only 'evm' serves several currencies from one address. */
  chain: string;
}) {
  const resolved = getDepositTokenNetwork({ code, ticker, network });
  const evenOn = resolved ? resolved.network : 'the same network';
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start" data-testid="deposit-network-warning">
      <IconAlertTriangle
        size={14}
        className="text-yellow-500"
        style={{ flexShrink: 0, marginTop: 2 }}
      />
      <div>
        {resolved && (
          <Badge
            data-testid="deposit-network-badge"
            size="sm"
            variant="light"
            color="yellow"
            radius="sm"
            fw={800}
            mb={4}
          >
            {resolved.token} · {resolved.network}
          </Badge>
        )}
        <Text size="xs" c="dimmed">
          {resolved ? (
            <>
              Send only <b>{resolved.token}</b> on the <b>{resolved.network}</b> network.
            </>
          ) : (
            <>
              Send only <b>{code.toUpperCase()}</b> on the network it belongs to.
            </>
          )}{' '}
          {getTail(resolved?.network)}
        </Text>
        <Text size="xs" c="dimmed" mt={4} data-testid="deposit-token-warning">
          {chain === 'evm' ? (
            <>
              Only the currencies listed in the selector are credited at this address. Any other
              token sent to it, even on {evenOn}, isn&apos;t converted and needs a manual refund.
            </>
          ) : (
            <>
              Only <b>{resolved ? resolved.token : code.toUpperCase()}</b> is credited. Any other
              token sent to this address, even on {evenOn}, isn&apos;t converted and needs a manual
              refund.
            </>
          )}
        </Text>
      </div>
    </Group>
  );
}
