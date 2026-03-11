import {
  ActionIcon,
  Badge,
  Group,
  Pagination,
  Paper,
  Popover,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconCheck,
  IconClock,
  IconInfoCircle,
  IconLoader,
  IconRefresh,
  IconWallet,
  IconWifiOff,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { outerCardStyle } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import dayjs from '~/shared/utils/dayjs';
import { numberWithCommas } from '~/utils/number-helpers';
import { getChainDisplayName } from '~/server/common/chain-config';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function DepositHistory() {
  const [page, setPage] = useState(1);
  const perPage = 3;
  const utils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const { status: signalStatus } = useSignalContext();

  const bustCacheMutation = trpc.nowPayments.bustDepositCache.useMutation({
    onSuccess: () => {
      utils.nowPayments.getDepositHistory.invalidate();
    },
  });

  const { data, isLoading } = trpc.nowPayments.getDepositHistory.useQuery(
    { page, perPage },
    { keepPreviousData: true, staleTime: 30 * 1000 }
  );

  // Reuse the supported currencies query (React Query deduplicates)
  const { data: currencies } = trpc.nowPayments.getSupportedCurrencies.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });

  // Build a lookup: currency code -> { ticker, network, chain, hasMultipleNetworks }
  const currencyLookup = useMemo(() => {
    if (!currencies) return {};
    const lookup: Record<
      string,
      { ticker: string; network: string | null | undefined; chain: string | null; hasMultipleNetworks: boolean }
    > = {};
    for (const group of currencies) {
      const hasMultipleNetworks = group.networks.length > 1;
      for (const net of group.networks) {
        lookup[net.code.toLowerCase()] = {
          ticker: (net.ticker ?? group.ticker).toUpperCase(),
          network: net.network,
          chain: net.chain ?? null,
          hasMultipleNetworks,
        };
      }
    }
    return lookup;
  }, [currencies]);

  // Live updates are handled by the global useCryptoDepositSignal hook
  // in SignalsRegistrar.tsx, which invalidates getDepositHistory on signal receipt.

  const deposits = (data?.deposits ?? []).filter(
    (d): d is NonNullable<typeof d> => d != null
  );
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / perPage);

  if (isLoading && deposits.length === 0) {
    return (
      <Paper p="lg" radius="md" withBorder style={outerCardStyle}>
        <Title order={5} mb="sm">
          Recent Deposits
        </Title>
        <Stack gap="sm">
          {[0, 1, 2].map((i) => (
            <Paper
              key={i}
              p="sm"
              radius="sm"
              withBorder
              className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10"
            >
              <Group justify="space-between" wrap="nowrap" align="center">
                <Stack gap={4}>
                  <Group gap={6}>
                    <Skeleton height={16} width={60} radius="sm" />
                    <Skeleton height={16} width={40} radius="sm" />
                  </Group>
                  <Skeleton height={12} width={100} radius="sm" />
                </Stack>
                <Stack gap={4} align="flex-end">
                  <Skeleton height={20} width={70} radius="sm" />
                  <Skeleton height={18} width={60} radius="xl" />
                </Stack>
              </Group>
            </Paper>
          ))}
        </Stack>
      </Paper>
    );
  }

  if (!isLoading && deposits.length === 0 && total === 0) {
    return (
      <EmptyDepositState
        signalStatus={signalStatus}
        onRefresh={() => utils.nowPayments.getDepositHistory.invalidate()}
      />
    );
  }

  return (
    <Paper p="lg" radius="md" withBorder style={outerCardStyle}>
      <Group justify="space-between" mb="sm">
        <Title order={5}>Recent Deposits</Title>
        <Group gap="xs" wrap="nowrap">
          {currentUser?.isModerator && (
            <Tooltip label="Bust cache - mod only" color="dark" withArrow withinPortal>
              <ActionIcon
                variant="subtle"
                color="orange"
                size="sm"
                loading={bustCacheMutation.isLoading}
                onClick={() => bustCacheMutation.mutate()}
              >
                <IconRefresh size={14} />
              </ActionIcon>
            </Tooltip>
          )}
          <SignalStatusBadge
            status={signalStatus}
            onRefresh={() => utils.nowPayments.getDepositHistory.invalidate()}
          />
        </Group>
      </Group>
      <Stack gap="sm">
        {deposits.map((deposit) => {
          const currencyInfo = currencyLookup[deposit.currencySent?.toLowerCase()];

          // Fee in USDC (settlement currency)
          const amountSent = Number(deposit.amountSent) || 0;
          const hasFeeRecord = deposit.depositFee != null && deposit.serviceFee != null;
          const totalFeeUsdc = hasFeeRecord
            ? (deposit.depositFee ?? 0) + (deposit.serviceFee ?? 0)
            : null;

          let feeUsdc: number | null = null;
          if (totalFeeUsdc != null && totalFeeUsdc > 0) {
            feeUsdc = totalFeeUsdc;
          } else if (
            !hasFeeRecord &&
            deposit.status === 'finished' &&
            deposit.outcomeAmount != null
          ) {
            const isStablecoin =
              currencyInfo?.ticker?.toUpperCase().startsWith('USDC') ||
              currencyInfo?.ticker?.toUpperCase().startsWith('PYUSD') ||
              deposit.currencySent?.toLowerCase().includes('usd');
            if (isStablecoin && amountSent > 0) {
              const diff = amountSent - deposit.outcomeAmount;
              if (diff > 0) feeUsdc = diff;
            }
          }

          const displayStatus = deposit.status;
          const ticker = currencyInfo?.ticker ?? deposit.currencySent?.toUpperCase() ?? '';
          // Show network badge for multi-network tickers (e.g., USDC on Base vs Polygon)
          const networkBadge =
            currencyInfo?.hasMultipleNetworks && currencyInfo.network
              ? getDisplayName(currencyInfo.network.toLowerCase())
              : null;
          // Show chain badge when no network badge is shown (so every row has context)
          const chainBadge =
            !networkBadge && currencyInfo?.chain
              ? getChainDisplayName(currencyInfo.chain)
              : null;

          return (
            <Paper
              key={deposit.paymentId}
              p="sm"
              radius="sm"
              withBorder
              className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10"
            >
              <Group justify="space-between" wrap="nowrap" align="center">
                {/* Left side */}
                <Stack gap={4}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={500}>
                      {deposit.amountSent}
                    </Text>
                    <Text size="sm" fw={600} tt="uppercase">
                      {ticker}
                    </Text>
                    {networkBadge && (
                      <Badge size="xs" variant="light" color="gray" radius="sm">
                        {networkBadge}
                      </Badge>
                    )}
                    {chainBadge && (
                      <Badge size="xs" variant="light" color="blue" radius="sm">
                        {chainBadge}
                      </Badge>
                    )}
                  </Group>
                  <Group gap="md" wrap="nowrap">
                    {feeUsdc != null && (
                      <Group gap={2} wrap="nowrap">
                        <Text size="xs" c="dimmed">
                          Fee: ${feeUsdc.toFixed(2)}
                        </Text>
                        <FeeInfoPopover />
                      </Group>
                    )}
                    <Group gap={4} wrap="nowrap">
                      <IconClock size={12} className="text-dimmed" />
                      <Text size="xs" c="dimmed">
                        <DepositDate date={deposit.date} />
                      </Text>
                    </Group>
                  </Group>
                </Stack>
                {/* Right side: buzz + status stacked */}
                {deposit.buzzCredited != null ? (
                  <Stack gap={2} align="flex-end">
                    <Group gap={4} wrap="nowrap">
                      <CurrencyIcon currency="BUZZ" size={18} />
                      <Text size="lg" fw={700}>
                        {numberWithCommas(deposit.buzzCredited)}
                      </Text>
                    </Group>
                    <DepositStatusBadge status={displayStatus} />
                  </Stack>
                ) : (
                  <DepositStatusBadge status={displayStatus} />
                )}
              </Group>
            </Paper>
          );
        })}
      </Stack>
      {totalPages > 1 && (
        <Group justify="center" mt="md">
          <Pagination total={totalPages} value={page} onChange={setPage} size="sm" />
        </Group>
      )}
      <Group gap="xs" mt="sm" wrap="nowrap" align="flex-start">
        <IconClock size={14} className="text-yellow-500" style={{ flexShrink: 0, marginTop: 2 }} />
        <Text size="xs" c="dimmed">
          Deposits can take up to 15 minutes to appear depending on the cryptocurrency and network.
        </Text>
      </Group>
    </Paper>
  );
}

function EmptyDepositState({
  signalStatus,
  onRefresh,
}: {
  signalStatus: string | null;
  onRefresh: () => void;
}) {
  return (
    <Paper p="lg" radius="md" withBorder style={outerCardStyle}>
      <Stack gap="sm" py="md">
        <Group justify="space-between">
          <Title order={5}>Recent Deposits</Title>
          <SignalStatusBadge status={signalStatus} onRefresh={onRefresh} />
        </Group>
        <Paper
          p="lg"
          radius="sm"
          withBorder
          className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10"
        >
          <Group justify="center" gap="xs" py="md">
            <IconWallet size={18} className="text-dimmed" stroke={1.5} />
            <Text size="sm" fw={500}>
              No deposits yet
            </Text>
          </Group>
        </Paper>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <IconClock
            size={14}
            className="text-yellow-500"
            style={{ flexShrink: 0, marginTop: 2 }}
          />
          <Text size="xs" c="dimmed">
            Deposits can take up to 15 minutes to appear depending on the cryptocurrency and
            network.
          </Text>
        </Group>
      </Stack>
    </Paper>
  );
}

function DepositDate({ date }: { date: string }) {
  const d = dayjs(date);
  const isRecent = dayjs().diff(d, 'hour') < 24;
  const display = isRecent ? d.fromNow() : d.format('MMM D, h:mma');
  return (
    <time title={d.format()} dateTime={d.format()}>
      {display}
    </time>
  );
}

function SignalStatusBadge({
  status,
  onRefresh,
}: {
  status: string | null;
  onRefresh: () => void;
}) {
  if (status === 'connected') {
    return (
      <Group gap={4} wrap="nowrap">
        <div className="relative flex items-center justify-center">
          <div className="absolute size-3 animate-ping rounded-full bg-green-500/40" />
          <div className="size-2 rounded-full bg-green-500" />
        </div>
        <Text size="xs" c="green">
          Live
        </Text>
      </Group>
    );
  }

  if (status === 'reconnecting') {
    return (
      <Group gap={4} wrap="nowrap">
        <IconRefresh size={14} className="text-yellow-500" />
        <Text size="xs" c="yellow">
          Reconnecting&hellip;
        </Text>
      </Group>
    );
  }

  return (
    <UnstyledButton onClick={onRefresh} aria-label="Refresh deposit history (live updates disconnected)">
      <Group gap={4} wrap="nowrap">
        <IconWifiOff size={14} className="text-red-500" />
        <Text size="xs" c="red" td="underline">
          Disconnected &mdash; refresh
        </Text>
      </Group>
    </UnstyledButton>
  );
}

function FeeInfoPopover() {
  return (
    <Popover width={280} position="top" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon variant="subtle" color="gray" size="xs" aria-label="Fee information">
          <IconInfoCircle size={14} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" fw={600}>
            About fees
          </Text>
          <Text size="xs" c="dimmed">
            Fees are charged by NowPayments and include two parts: a{' '}
            <Text span fw={500} c="dimmed">
              service fee
            </Text>{' '}
            (0.5% payment processing fee) and a{' '}
            <Text span fw={500} c="dimmed">
              network fee
            </Text>{' '}
            (covers the blockchain transaction and any currency conversion).
          </Text>
          <Text size="xs" c="dimmed">
            For the lowest total fees, send USDC on Base — no conversion is needed so the network
            fee is minimal. Other currencies have higher fees due to conversion and network costs.
          </Text>
          <Text size="xs" c="dimmed">
            Civitai does not charge any additional fee — you receive Buzz for the full amount we
            receive after NowPayments&rsquo; fees.
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function DepositStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'finished':
      return (
        <Badge color="green" variant="light" size="sm" leftSection={<IconCheck size={12} />}>
          Complete
        </Badge>
      );
    case 'confirmed':
      return (
        <Badge color="blue" variant="light" size="sm" leftSection={<IconCheck size={12} />}>
          Confirmed
        </Badge>
      );
    case 'confirming':
      return (
        <Badge color="yellow" variant="light" size="sm" leftSection={<IconLoader size={12} />}>
          Confirming
        </Badge>
      );
    case 'waiting':
      return (
        <Badge color="gray" variant="light" size="sm" leftSection={<IconClock size={12} />}>
          Waiting
        </Badge>
      );
    default:
      return (
        <Badge color="gray" variant="light" size="sm">
          {status}
        </Badge>
      );
  }
}
