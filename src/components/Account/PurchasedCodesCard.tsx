import { useMemo, useState } from 'react';
import {
  Text,
  Stack,
  Group,
  Title,
  Box,
  Badge,
  Paper,
  Center,
  CopyButton,
  Button,
  Tooltip,
  Pagination,
  Skeleton,
  SegmentedControl,
  UnstyledButton,
} from '@mantine/core';
import buzzClasses from '~/components/Buzz/buzz.module.scss';
import { IconCopy, IconCheck, IconGift, IconTicket } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';

const DEFAULT_PAGE_SIZE = 10;
const COMPACT_PAGE_SIZE = 3;

const MEMBERSHIP_BUZZ_PER_MONTH: Record<string, number> = {
  bronze: 10000,
  silver: 25000,
  gold: 50000,
};

type PurchasedCode = {
  code: string;
  type: string;
  unitValue: number;
  createdAt: Date;
  expiresAt: Date | null;
  redeemedAt: Date | null;
  priceId: string | null;
  price: { product: { metadata: unknown } } | null;
};

type CodeRowProps = {
  item: PurchasedCode;
  onInvalidate: () => void;
};

function useCodeRowData(item: PurchasedCode) {
  const isRedeemed = !!item.redeemedAt;
  const tier =
    item.type === 'Membership' && item.price?.product?.metadata
      ? (item.price.product.metadata as { tier?: string })?.tier
      : undefined;
  const description =
    item.type === 'Buzz'
      ? `${item.unitValue.toLocaleString()} Buzz`
      : `${item.unitValue}-mo ${tier ? tier.charAt(0).toUpperCase() + tier.slice(1) + ' ' : ''}Membership`;

  return { isRedeemed, tier, description };
}

function useRedeemMutation(onInvalidate: () => void) {
  return trpc.redeemableCode.consume.useMutation({
    async onSuccess() {
      showSuccessNotification({ message: 'Code redeemed successfully!' });
      onInvalidate();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to redeem code',
        error: new Error(error.message),
      });
    },
  });
}

function CopyableCode({ code }: { code: string }) {
  return (
    <CopyButton value={code}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copied!' : 'Click to copy'} position="top">
          <UnstyledButton
            onClick={copy}
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-gray-500 dark:text-gray-400 bg-black/5 hover:bg-black/10 dark:bg-black/20 dark:hover:bg-black/30 transition-colors"
          >
            <span>{code}</span>
            {copied ? (
              <IconCheck size={11} stroke={1.5} className="text-teal-400 shrink-0" />
            ) : (
              <IconCopy size={11} stroke={1.5} className="opacity-50 shrink-0" />
            )}
          </UnstyledButton>
        </Tooltip>
      )}
    </CopyButton>
  );
}

function CodeRow({ item, onInvalidate }: CodeRowProps) {
  const { isRedeemed, description } = useCodeRowData(item);
  const redeemMutation = useRedeemMutation(onInvalidate);
  const accentColor =
    item.type === 'Buzz' ? 'var(--mantine-color-yellow-5)' : 'var(--mantine-color-blue-5)';

  return (
    <Paper
      p="sm"
      radius="sm"
      withBorder
      className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10"
      style={{
        borderLeft: `3px solid ${accentColor}`,
      }}
    >
      <Group justify="space-between" wrap="nowrap" align="center">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Text size="sm" fw={700}>
            {description}
          </Text>
          <div style={{ alignSelf: 'flex-start' }}>
            <CopyableCode code={item.code} />
          </div>
        </Stack>
        <Stack gap={4} align="flex-end" style={{ flexShrink: 0 }}>
          {isRedeemed ? (
            <Badge variant="light" color="green" size="sm">
              Redeemed
            </Badge>
          ) : (
            <Button
              size="compact-xs"
              leftSection={<IconGift size={14} stroke={1.5} />}
              loading={redeemMutation.isLoading}
              onClick={() => redeemMutation.mutate({ code: item.code })}
            >
              Redeem
            </Button>
          )}
          <Text size="xs" c="dimmed">
            {formatDate(item.createdAt)}
          </Text>
        </Stack>
      </Group>
    </Paper>
  );
}

/** Summarizes membership codes: groups by tier+duration and totals buzz payments. */
function MembershipSummary({ codes }: { codes: PurchasedCode[] }) {
  const summary = useMemo(() => {
    // Group redeemed membership codes by tier+unitValue
    const groups = new Map<string, { tier: string; months: number; count: number }>();
    let totalBuzzPayments = 0;
    let totalBuzz = 0;

    for (const code of codes) {
      if (code.type !== 'Membership' || !code.redeemedAt) continue;
      const tier =
        (code.price?.product?.metadata as { tier?: string })?.tier?.toLowerCase() ?? 'bronze';
      const key = `${tier}-${code.unitValue}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(key, { tier, months: code.unitValue, count: 1 });
      }
      totalBuzzPayments += code.unitValue;
      totalBuzz += code.unitValue * (MEMBERSHIP_BUZZ_PER_MONTH[tier] ?? 10000);
    }

    return { groups: Array.from(groups.values()), totalBuzzPayments, totalBuzz };
  }, [codes]);

  if (summary.groups.length === 0) return null;

  return (
    <Paper
      p="sm"
      radius="sm"
      withBorder
      className="bg-blue-50/50 dark:bg-blue-500/[0.06] border-blue-200 dark:border-blue-500/20"
    >
      <Stack gap={4}>
        <Text size="xs" fw={600} c="blue">
          Membership Summary (Redeemed)
        </Text>
        {summary.groups.map(({ tier, months, count }) => (
          <Text key={`${tier}-${months}`} size="xs">
            {count} × {months}-Month{' '}
            <Text span tt="capitalize" fw={600} inherit>
              {tier}
            </Text>{' '}
            Membership = {count * months} Buzz payment{count * months !== 1 ? 's' : ''}
          </Text>
        ))}
        <Text size="xs" fw={600} mt={2}>
          Total: {summary.totalBuzzPayments} Buzz payment
          {summary.totalBuzzPayments !== 1 ? 's' : ''} ({summary.totalBuzz.toLocaleString()} Buzz)
        </Text>
      </Stack>
    </Paper>
  );
}

type FilterType = 'all' | 'Membership' | 'Buzz';

export function PurchasedCodesCard({
  compact,
  defaultFilter = 'all',
}: { compact?: boolean; defaultFilter?: FilterType } = {}) {
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<FilterType>(defaultFilter);
  const pageSize = compact ? COMPACT_PAGE_SIZE : DEFAULT_PAGE_SIZE;

  const { data, isLoading } = trpc.redeemableCode.getMyPurchasedCodes.useQuery();
  const allCodes = data ?? [];

  // Check if we have multiple code types to show the filter
  const hasMembership = allCodes.some((c) => c.type === 'Membership');
  const hasBuzz = allCodes.some((c) => c.type === 'Buzz');
  const showFilter = hasMembership && hasBuzz;

  const codes = filter === 'all' ? allCodes : allCodes.filter((c) => c.type === filter);

  const totalPages = Math.ceil(codes.length / pageSize);
  const paginatedCodes = codes.slice((page - 1) * pageSize, page * pageSize);

  const handleFilterChange = (value: string) => {
    setFilter(value as FilterType);
    setPage(1);
  };

  return (
    <Paper className={buzzClasses.tileCard} id="purchased-codes" h="100%" p="lg" radius="md">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Title order={4}>Purchased Codes</Title>
        {showFilter && !isLoading && (
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={handleFilterChange}
            data={[
              { label: 'All', value: 'all' },
              { label: 'Membership', value: 'Membership' },
              { label: 'Buzz', value: 'Buzz' },
            ]}
          />
        )}
      </Group>
      <Box mt="md">
        {isLoading ? (
          <Stack gap="xs">
            {Array.from({ length: compact ? COMPACT_PAGE_SIZE : 3 }).map((_, i) => (
              <Paper
                key={i}
                p="sm"
                radius="sm"
                withBorder
                className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/10"
                style={{ borderLeft: '3px solid var(--mantine-color-gray-4)' }}
              >
                <Group justify="space-between" wrap="nowrap" align="center">
                  <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                    <Skeleton height={14} width="60%" radius="sm" />
                    <Skeleton height={12} width="40%" radius="sm" />
                  </Stack>
                  <Stack gap={4} align="flex-end" style={{ flexShrink: 0 }}>
                    <Skeleton height={22} width={70} radius="sm" />
                    <Skeleton height={10} width={60} radius="sm" />
                  </Stack>
                </Group>
              </Paper>
            ))}
          </Stack>
        ) : codes.length === 0 ? (
          <Stack align="center" gap={6} py="xl">
            <IconTicket size={32} stroke={1.5} style={{ opacity: 0.3 }} />
            <Text size="sm" fw={500} c="white">
              {filter === 'all' ? 'No codes yet' : `No ${filter.toLowerCase()} codes`}
            </Text>
            <Text size="xs" c="dimmed">
              {filter === 'all'
                ? 'Redeem a code above to see it here'
                : 'Try a different filter'}
            </Text>
          </Stack>
        ) : (
          <Stack gap="xs">
            {filter === 'Membership' && <MembershipSummary codes={allCodes} />}
            {paginatedCodes.map((item) => (
              <CodeRow
                key={item.code}
                item={item}
                onInvalidate={() => utils.redeemableCode.getMyPurchasedCodes.invalidate()}
              />
            ))}
            {totalPages > 1 && (
              <Center mt="sm">
                <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
              </Center>
            )}
          </Stack>
        )}
      </Box>
    </Paper>
  );
}
