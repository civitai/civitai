import {
  ActionIcon,
  Badge,
  Group,
  HoverCard,
  Pagination,
  Paper,
  Popover,
  Skeleton,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import {
  IconCheck,
  IconClock,
  IconLoader,
  IconPlus,
  IconRefresh,
  IconWallet,
  IconWifiOff,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import useIsClient from '~/hooks/useIsClient';
import { BonusBuzzContent } from '~/components/Buzz/CryptoDeposit/BonusBuzzContent';
import { outerCardStyle } from '~/components/Buzz/CryptoDeposit/crypto-deposit.constants';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { numberWithCommas } from '~/utils/number-helpers';
import { getNetworkDisplayName } from '~/server/common/chain-config';
import { useSupportedCurrencies } from '~/components/Buzz/CryptoDeposit/crypto-deposit.hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function DepositHistory() {
  const isClient = useIsClient();
  const currentUser = useCurrentUser();
  const [page, setPage] = useState(1);
  const perPage = 3;
  const utils = trpc.useUtils();
  const { status: signalStatus } = useSignalContext();

  const { data, isLoading } = trpc.nowPayments.getDepositHistory.useQuery(
    { page, perPage },
    { keepPreviousData: true, staleTime: 30 * 1000, enabled: !!currentUser }
  );

  // Reuse supported currencies query (React Query deduplicates) for ticker/network display
  const { data: currencies } = useSupportedCurrencies();

  // Build a lookup: NowPayments currency code → { ticker, network, multiNetwork }
  const currencyLookup = useMemo(() => {
    if (!currencies) return {};
    const lookup: Record<string, { ticker: string; network: string | null | undefined; multiNetwork: boolean }> = {};
    for (const group of currencies) {
      const multiNetwork = group.networks.length > 1;
      for (const net of group.networks) {
        lookup[net.code.toLowerCase()] = {
          ticker: (net.ticker ?? group.ticker).toUpperCase(),
          network: net.network,
          multiNetwork,
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

  if (!isClient) return null;

  if (isLoading && deposits.length === 0) {
    return (
      <Paper p="lg" radius="md" withBorder style={outerCardStyle}>
        <Title order={5} mb="sm">
          Your Recent Deposits
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
        <Title order={5}>Your Recent Deposits</Title>
        <SignalStatusBadge
          status={signalStatus}
          onRefresh={() => utils.nowPayments.getDepositHistory.invalidate()}
        />
      </Group>
      <Stack gap="sm">
        {deposits.map((deposit) => {
          // Only show fees once the deposit is complete (fees aren't final until then)
          let feeUsdc: number | null = null;
          if (deposit.status === 'finished') {
            const hasFeeRecord = deposit.depositFee != null && deposit.serviceFee != null;
            const totalFeeUsdc = hasFeeRecord
              ? (deposit.depositFee ?? 0) + (deposit.serviceFee ?? 0)
              : null;

            if (totalFeeUsdc != null && totalFeeUsdc > 0) {
              feeUsdc = totalFeeUsdc;
            } else if (
              !hasFeeRecord &&
              deposit.outcomeAmount != null &&
              deposit.amountSent != null
            ) {
              // Estimate fee for stablecoins
              const currency = deposit.currencySent?.toLowerCase() ?? '';
              const isStablecoin = currency.includes('usd');
              if (isStablecoin && deposit.amountSent > 0) {
                const diff = deposit.amountSent - deposit.outcomeAmount;
                if (diff > 0) feeUsdc = diff;
              }
            }
          }

          const currencyInfo = currencyLookup[deposit.currencySent?.toLowerCase() ?? ''];
          const ticker = currencyInfo?.ticker ?? deposit.currencySent?.toUpperCase() ?? '';
          // Show network badge when the ticker exists on multiple networks (USDC, USDT, etc.)
          const networkBadge =
            currencyInfo?.multiNetwork && currencyInfo.network
              ? getNetworkDisplayName(currencyInfo.network)
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
                  </Group>
                  <Group gap="md" wrap="nowrap">
                    {feeUsdc != null && (
                      <FeePopover amount={feeUsdc} />
                    )}
                    <Group gap={4} wrap="nowrap">
                      <IconClock size={12} className="text-dimmed" />
                      <Text size="xs" c="dimmed">
                        <DaysFromNow date={deposit.date} live />
                      </Text>
                    </Group>
                  </Group>
                </Stack>
                {/* Right side: buzz + bonus + status stacked */}
                {deposit.buzzCredited != null ? (
                  <Stack gap={2} align="flex-end">
                    <Group gap={4} wrap="nowrap">
                      <CurrencyIcon currency="BUZZ" size={18} />
                      <Text size="lg" fw={700}>
                        {numberWithCommas(deposit.buzzCredited)}
                      </Text>
                      {deposit.bonusBuzz != null && deposit.bonusBuzz > 0 && (
                        <div className="ml-1">
                          <BonusBuzzPopover
                            bonusBuzz={deposit.bonusBuzz}
                            multiplier={deposit.multiplier}
                          />
                        </div>
                      )}
                    </Group>
                    <DepositStatusBadge status={deposit.status} />
                  </Stack>
                ) : (
                  <DepositStatusBadge status={deposit.status} />
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
      <CheckDepositsNotice
        onSuccess={() => utils.nowPayments.getDepositHistory.invalidate()}
      />
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
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={5}>Your Recent Deposits</Title>
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
        <CheckDepositsNotice onSuccess={onRefresh} />
      </Stack>
    </Paper>
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
      <HoverCard width={220} position="bottom-end" withArrow shadow="md" openDelay={300}>
        <HoverCard.Target>
          <Group gap={4} wrap="nowrap" className="cursor-help">
            <div className="relative flex items-center justify-center">
              <div className="absolute size-3 animate-ping rounded-full bg-green-500/40" />
              <div className="size-2 rounded-full bg-green-500" />
            </div>
            <Text size="xs" c="green">
              Live
            </Text>
          </Group>
        </HoverCard.Target>
        <HoverCard.Dropdown>
          <Text size="xs">
            Deposits will appear automatically as they&rsquo;re confirmed on the blockchain. No need
            to refresh.
          </Text>
        </HoverCard.Dropdown>
      </HoverCard>
    );
  }

  if (status === 'reconnecting') {
    return (
      <HoverCard width={220} position="bottom-end" withArrow shadow="md" openDelay={300}>
        <HoverCard.Target>
          <Group gap={4} wrap="nowrap" className="cursor-help">
            <IconRefresh size={14} className="text-yellow-500" />
            <Text size="xs" c="yellow">
              Reconnecting&hellip;
            </Text>
          </Group>
        </HoverCard.Target>
        <HoverCard.Dropdown>
          <Text size="xs">
            Reconnecting to live updates. Deposits are still being processed &mdash; they&rsquo;ll
            appear once the connection is restored.
          </Text>
        </HoverCard.Dropdown>
      </HoverCard>
    );
  }

  return (
    <HoverCard width={220} position="bottom-end" withArrow shadow="md" openDelay={300}>
      <HoverCard.Target>
        <UnstyledButton onClick={onRefresh} aria-label="Refresh deposit history">
          <Group gap={4} wrap="nowrap">
            <IconWifiOff size={14} className="text-red-500" />
            <Text size="xs" c="red" td="underline">
              Disconnected &mdash; refresh
            </Text>
          </Group>
        </UnstyledButton>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Text size="xs">
          Live updates are disconnected. Click to refresh manually, or use &ldquo;Check now&rdquo;
          below to scan for missing deposits.
        </Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function FeePopover({ amount }: { amount: number }) {
  const display = `Fee: $${(Math.ceil(amount * 100) / 100).toFixed(2)}`;
  return (
    <Popover width={280} position="top" withArrow shadow="md">
      <Popover.Target>
        <UnstyledButton
          className="cursor-help"
          aria-label="Fee information"
        >
          <Text
            size="xs"
            c="dimmed"
            className="underline decoration-dotted decoration-gray-400 dark:decoration-gray-600 underline-offset-2"
          >
            {display}
          </Text>
        </UnstyledButton>
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

function BonusBuzzPopover({
  bonusBuzz,
  multiplier,
}: {
  bonusBuzz: number;
  multiplier: number | null | undefined;
}) {
  return (
    <HoverCard
      width={240}
      position="top"
      withArrow
      shadow="md"
      openDelay={500}
      styles={{
        dropdown: {
          background: 'var(--mantine-color-yellow-light)',
          border: 'none',
          backdropFilter: 'blur(16px)',
        },
      }}
    >
      <HoverCard.Target>
        <ActionIcon variant="light" color="yellow" size="xs" radius="xs" aria-label="Membership bonus details">
          <IconPlus size={12} />
        </ActionIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <BonusBuzzContent bonusBuzz={bonusBuzz} multiplier={multiplier ?? 100} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function CheckDepositsNotice({ onSuccess }: { onSuccess: () => void }) {
  const reconcileMutation = trpc.nowPayments.reconcileMyDeposits.useMutation({
    onSuccess: (data) => {
      if (data.processed > 0) onSuccess();
    },
  });

  const linkText = reconcileMutation.isLoading
    ? 'Checking...'
    : reconcileMutation.isSuccess
    ? reconcileMutation.data.processed > 0
      ? `Found ${reconcileMutation.data.processed} deposit(s)!`
      : 'No missing deposits found'
    : reconcileMutation.isError
    ? 'Try again in a minute'
    : 'Missing a deposit? Check now';

  return (
    <Group gap="xs" mt="sm" wrap="nowrap" align="center">
      <IconClock size={14} className="text-yellow-500" style={{ flexShrink: 0 }} />
      <Text size="xs" c="dimmed" lh={1.4}>
        Deposits can take up to 1 hour to appear depending on network congestion.{' '}
        <UnstyledButton
          onClick={() => !reconcileMutation.isLoading && reconcileMutation.mutate()}
          disabled={reconcileMutation.isLoading}
          style={{ display: 'inline' }}
        >
          <Text
            span
            size="xs"
            c={reconcileMutation.isSuccess && reconcileMutation.data.processed > 0 ? 'green' : 'dimmed'}
            td="underline"
            className="cursor-pointer"
          >
            {reconcileMutation.isLoading && <IconLoader size={10} className="inline mr-1 animate-spin" />}
            {linkText}
          </Text>
        </UnstyledButton>
      </Text>
    </Group>
  );
}

function DepositStatusBadge({ status }: { status: string }) {
  if (status === 'finished') {
    return (
      <Badge color="green" variant="light" size="sm" leftSection={<IconCheck size={12} />}>
        Complete
      </Badge>
    );
  }

  switch (status) {
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
    case 'buzz_failed':
      return (
        <Badge color="orange" variant="light" size="sm" leftSection={<IconRefresh size={12} />}>
          Processing
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
