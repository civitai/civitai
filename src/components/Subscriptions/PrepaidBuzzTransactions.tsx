import {
  Badge,
  Center,
  Collapse,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconBolt, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import dayjs from '~/shared/utils/dayjs';
import { useMemo, useRef, useState } from 'react';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import styles from './PrepaidTimelineProgress.module.scss';

const TIER_COLORS: Record<string, string> = {
  gold: 'yellow',
  silver: 'gray',
  bronze: 'orange',
};

const BUZZ_TO_TIER: Record<number, string> = {
  50000: 'gold',
  25000: 'silver',
  10000: 'bronze',
};

function inferTierFromAmount(amount: number): string {
  return BUZZ_TO_TIER[amount] ?? 'unknown';
}

/** Mask a code like MB-ABCD-EFGH → MB-AB...EFGH */
function maskCode(code: string): string {
  if (code.length <= 7) return code;
  return `${code.slice(0, 5)}...${code.slice(-4)}`;
}

interface ParsedTransaction {
  date: string;
  amount: number;
  tier: string;
  monthLabel: string;
  isRedemption: boolean;
  externalTransactionId: string;
}

interface ConsumedCode {
  code: string;
  unitValue: number;
  redeemedAt: Date | string;
  tier: string;
  monthlyBuzz: number;
}

interface CodeGroup {
  code: ConsumedCode;
  transactions: ParsedTransaction[];
  totalBuzz: number;
  totalMonthlyBuzz: number;
}

interface PrepaidBuzzTransactionsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscription: any;
}

export function PrepaidBuzzTransactions({ subscription }: PrepaidBuzzTransactionsProps) {
  const meta = subscription?.product?.metadata as SubscriptionProductMetadata | null;
  const isCivitaiProvider = subscription?.product?.provider === 'Civitai';
  const features = useFeatureFlags();

  if (!isCivitaiProvider || !features.prepaidBuzzTransactions) return null;

  return <PrepaidBuzzTransactionsInner buzzType={meta?.buzzType} />;
}

function PrepaidBuzzTransactionsInner({ buzzType }: { buzzType?: string }) {
  const datesRef = useRef({
    start: dayjs().subtract(12, 'months').startOf('day').toDate(),
    end: dayjs().endOf('day').toDate(),
  });

  const { data: txData, isLoading: txLoading } = trpc.buzz.getUserTransactions.useQuery({
    type: TransactionType.Purchase,
    start: datesRef.current.start,
    end: datesRef.current.end,
    limit: 200,
    accountType: buzzType === 'green' ? 'green' : 'yellow',
  });

  const { data: codesData, isLoading: codesLoading } =
    trpc.redeemableCode.getMyConsumedMembershipCodes.useQuery();

  const { codeGroups, unmatchedTransactions } = useMemo(() => {
    if (!txData || !codesData) return { codeGroups: [], unmatchedTransactions: [] };

    // Parse consumed codes
    const codes: ConsumedCode[] = codesData.map((c) => {
      const productMeta = c.price?.product?.metadata as Record<string, unknown> | undefined;
      return {
        code: c.code,
        unitValue: c.unitValue,
        redeemedAt: c.redeemedAt!,
        tier: ((productMeta?.tier as string) ?? 'unknown').toLowerCase(),
        monthlyBuzz: Number(productMeta?.monthlyBuzz ?? 0),
      };
    });

    // Parse transactions
    const allTx: ParsedTransaction[] = txData.transactions
      .filter((t) => {
        const extId = t.externalTransactionId;
        if (extId && extId.startsWith('civitai-membership')) return true;
        const detailsType = (t.details as Record<string, unknown> | null | undefined)?.type;
        return (
          detailsType === 'membership-purchase' || detailsType === 'civitai-membership-payment'
        );
      })
      .map((t) => {
        const details = t.details as Record<string, unknown> | null | undefined;
        const date = details?.date as string | undefined;
        const tier = (details?.tier as string) ?? inferTierFromAmount(t.amount);
        const extId = t.externalTransactionId ?? '';
        const isRedemption =
          details?.type === 'membership-purchase' ||
          (extId.startsWith('civitai-membership') &&
            !extId.endsWith(':v3') &&
            !extId.endsWith(':v2') &&
            !extId.endsWith(':v1'));

        return {
          date: t.date as unknown as string,
          amount: t.amount,
          tier,
          monthLabel: date ?? dayjs(t.date).format('YYYY-MM'),
          isRedemption,
          externalTransactionId: extId,
        };
      });

    // --- Matching Algorithm ---

    // Step 1: Direct match via externalTransactionId suffix (redemption transactions)
    const codeMap = new Map<string, ConsumedCode>(codes.map((c) => [c.code, c]));
    const codeGroupMap = new Map<string, ParsedTransaction[]>();
    codes.forEach((c) => codeGroupMap.set(c.code, []));

    const unmatched: ParsedTransaction[] = [];
    const remainingTx: ParsedTransaction[] = [];

    for (const tx of allTx) {
      if (tx.isRedemption && tx.externalTransactionId) {
        // Extract code suffix: civitai-membership:YYYY-MM:uid:pid:MB-XXXX-XXXX
        const parts = tx.externalTransactionId.split(':');
        const codeSuffix = parts.length >= 5 ? parts.slice(4).join(':') : null;
        if (codeSuffix && codeMap.has(codeSuffix)) {
          codeGroupMap.get(codeSuffix)!.push(tx);
          continue;
        }
      }
      remainingTx.push(tx);
    }

    // Step 2: FIFO + tier-aware assignment for job deliveries (:v3)
    // Build budget for each code: unitValue months, minus 1 if it had a direct-matched redemption
    const budgets = new Map<string, number>();
    for (const c of codes) {
      const directMatched = codeGroupMap.get(c.code)!.length;
      budgets.set(c.code, Math.max(0, c.unitValue - directMatched));
    }

    // Sort remaining transactions by date ascending for FIFO
    const sortedRemaining = [...remainingTx].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    for (const tx of sortedRemaining) {
      const txTier = inferTierFromAmount(tx.amount);

      // Try tier-matched code first (earliest with remaining budget)
      let assigned = false;
      for (const c of codes) {
        const remaining = budgets.get(c.code)!;
        if (remaining > 0 && c.tier === txTier) {
          codeGroupMap.get(c.code)!.push(tx);
          budgets.set(c.code, remaining - 1);
          assigned = true;
          break;
        }
      }

      if (!assigned) {
        unmatched.push(tx);
      }
    }

    // Build final groups (most recent code first)
    const groups: CodeGroup[] = [...codes].reverse().map((c) => {
      const txs = codeGroupMap.get(c.code)!;
      // Sort transactions newest first for display
      txs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      return {
        code: c,
        transactions: txs,
        totalBuzz: txs.reduce((sum, t) => sum + t.amount, 0),
        totalMonthlyBuzz: c.unitValue * c.monthlyBuzz,
      };
    });

    // Sort unmatched newest first
    unmatched.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return { codeGroups: groups, unmatchedTransactions: unmatched };
  }, [txData, codesData]);

  const isLoading = txLoading || codesLoading;

  if (isLoading) {
    return (
      <Paper withBorder className={styles.card}>
        <Center py="md">
          <Loader size="sm" />
        </Center>
      </Paper>
    );
  }

  const totalTx =
    codeGroups.reduce((sum, g) => sum + g.transactions.length, 0) + unmatchedTransactions.length;
  if (totalTx === 0) return null;

  return (
    <Paper withBorder className={styles.card}>
      <Stack>
        <Group justify="space-between">
          <Title order={3}>Prepaid Buzz Deliveries</Title>
          <Text size="xs" c="dimmed">
            {totalTx} transaction{totalTx !== 1 ? 's' : ''}
          </Text>
        </Group>
        <Text size="sm" c="dimmed">
          These are the Buzz deliveries from your prepaid membership codes. Each code grants monthly
          Buzz for its tier over its duration.
        </Text>

        {codeGroups.map((group) => (
          <CodeGroupCard key={group.code.code} group={group} />
        ))}

        {unmatchedTransactions.length > 0 && (
          <UnmatchedSection transactions={unmatchedTransactions} />
        )}
      </Stack>
    </Paper>
  );
}

function CodeGroupCard({ group }: { group: CodeGroup }) {
  const [open, setOpen] = useState(true);
  const { code, transactions, totalBuzz, totalMonthlyBuzz } = group;

  return (
    <Paper withBorder p="sm" radius="sm">
      <UnstyledButton onClick={() => setOpen((o) => !o)} w="100%">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
            <Text size="sm" fw={600} ff="monospace">
              {maskCode(code.code)}
            </Text>
            <Badge size="sm" variant="light" color={TIER_COLORS[code.tier] ?? 'gray'} tt="capitalize">
              {code.tier}
            </Badge>
            <Text size="xs" c="dimmed">
              Redeemed {dayjs(code.redeemedAt).format('MMM D, YYYY')}
            </Text>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Text size="xs" c="dimmed">
              {transactions.length}/{code.unitValue} months
            </Text>
            {totalMonthlyBuzz > 0 && (
              <Text size="xs" c="dimmed">
                ({numberWithCommas(totalBuzz)}/{numberWithCommas(totalMonthlyBuzz)})
              </Text>
            )}
            <IconBolt size={14} fill="currentColor" color="var(--mantine-color-yellow-6)" />
          </Group>
        </Group>
      </UnstyledButton>

      <Collapse in={open}>
        {transactions.length === 0 ? (
          <Text size="sm" c="dimmed" mt="xs" ml={28}>
            No deliveries yet — next delivery will appear here.
          </Text>
        ) : (
          <TransactionTable transactions={transactions} />
        )}
      </Collapse>
    </Paper>
  );
}

function UnmatchedSection({ transactions }: { transactions: ParsedTransaction[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Paper withBorder p="sm" radius="sm">
      <UnstyledButton onClick={() => setOpen((o) => !o)} w="100%">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
            <Text size="sm" fw={600}>
              Other Transactions
            </Text>
            <Text size="xs" c="dimmed">
              {transactions.length} transaction{transactions.length !== 1 ? 's' : ''}
            </Text>
          </Group>
        </Group>
      </UnstyledButton>
      <Collapse in={open}>
        <TransactionTable transactions={transactions} />
      </Collapse>
    </Paper>
  );
}

function TransactionTable({ transactions }: { transactions: ParsedTransaction[] }) {
  return (
    <Table highlightOnHover mt="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Date</Table.Th>
          <Table.Th>Period</Table.Th>
          <Table.Th>Tier</Table.Th>
          <Table.Th style={{ textAlign: 'right' }}>Amount</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {transactions.map((tx, i) => (
          <Table.Tr key={i}>
            <Table.Td>
              <Tooltip label={dayjs(tx.date).format('MMM D, YYYY h:mm A')}>
                <Text size="sm">{dayjs(tx.date).format('MMM D, YYYY')}</Text>
              </Tooltip>
            </Table.Td>
            <Table.Td>
              <Group gap={4}>
                <Text size="sm">{tx.monthLabel}</Text>
                {tx.isRedemption && (
                  <Badge size="xs" variant="light" color="blue">
                    Redemption
                  </Badge>
                )}
              </Group>
            </Table.Td>
            <Table.Td>
              <Badge
                size="sm"
                variant="light"
                color={TIER_COLORS[tx.tier] ?? 'gray'}
                tt="capitalize"
              >
                {tx.tier}
              </Badge>
            </Table.Td>
            <Table.Td style={{ textAlign: 'right' }}>
              <Group gap={4} justify="flex-end">
                <IconBolt size={14} fill="currentColor" color="var(--mantine-color-yellow-6)" />
                <Text size="sm" fw={600} style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {numberWithCommas(tx.amount)}
                </Text>
              </Group>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
