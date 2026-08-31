import {
  Badge,
  Box,
  Button,
  Center,
  Group,
  Pagination,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconGift } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import buzzClasses from '~/components/Buzz/buzz.module.scss';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatDate } from '~/utils/date-helpers';
import { capitalize } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const DEFAULT_PAGE_SIZE = 5;
const COMPACT_PAGE_SIZE = 3;

const statusColors: Record<string, string> = {
  Fulfilled: 'green',
  Failed: 'red',
  Refunded: 'orange',
  Revoked: 'orange',
};

type GiftRow = {
  id: string;
  kind: 'received' | 'sent';
  tier: string;
  months: number;
  date: Date | null;
  otherParty: string | null;
  message?: string | null;
  status?: string;
};

function GiftRowItem({ row }: { row: GiftRow }) {
  const received = row.kind === 'received';
  const accentColor = received ? 'var(--mantine-color-teal-5)' : 'var(--mantine-color-blue-5)';

  return (
    <Paper
      p="sm"
      radius="sm"
      withBorder
      className="border border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-white/[0.03]"
      style={{ borderLeft: `3px solid ${accentColor}` }}
    >
      <Group justify="space-between" wrap="nowrap" align="center">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Text size="sm" fw={700}>
            {row.months}-mo {capitalize(row.tier)} Membership
          </Text>
          <Text size="xs" c="dimmed">
            {received
              ? row.otherParty
                ? `from @${row.otherParty}`
                : 'from an anonymous gifter'
              : `to @${row.otherParty}`}
          </Text>
          {row.message && (
            <Text size="xs" c="dimmed" fs="italic" lineClamp={2}>
              &ldquo;{row.message}&rdquo;
            </Text>
          )}
        </Stack>
        <Stack gap={4} align="flex-end" style={{ flexShrink: 0 }}>
          {received ? (
            <Badge variant="light" color="teal" size="sm">
              Received
            </Badge>
          ) : (
            <Badge variant="light" color={statusColors[row.status ?? ''] ?? 'gray'} size="sm">
              {row.status}
            </Badge>
          )}
          {row.date && (
            <Text size="xs" c="dimmed">
              {formatDate(row.date)}
            </Text>
          )}
        </Stack>
      </Group>
    </Paper>
  );
}

type FilterType = 'all' | 'received' | 'sent';

export function MembershipGiftsCard({
  compact,
  showGiftAction = true,
}: { compact?: boolean; showGiftAction?: boolean } = {}) {
  const features = useFeatureFlags();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<FilterType>('all');
  const pageSize = compact ? COMPACT_PAGE_SIZE : DEFAULT_PAGE_SIZE;

  const { data, isLoading } = trpc.membershipGift.getMyGifts.useQuery(undefined, {
    enabled: features.giftMemberships,
  });

  const rows = useMemo<GiftRow[]>(() => {
    if (!data) return [];
    const received = data.received.map(
      (gift: (typeof data)['received'][number]): GiftRow => ({
        id: gift.id,
        kind: 'received',
        tier: gift.tier,
        months: gift.months,
        date: gift.fulfilledAt,
        otherParty: gift.gifter?.username ?? null,
        message: gift.message,
      })
    );
    const sent = data.sent.map(
      (gift: (typeof data)['sent'][number]): GiftRow => ({
        id: gift.id,
        kind: 'sent',
        tier: gift.tier,
        months: gift.months,
        date: gift.createdAt,
        otherParty: gift.recipient.username,
        status: gift.status,
      })
    );
    return [...received, ...sent].sort(
      (a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0)
    );
  }, [data]);

  if (!features.giftMemberships || isLoading || rows.length === 0) return null;

  const hasBoth = rows.some((r) => r.kind === 'received') && rows.some((r) => r.kind === 'sent');
  const filtered = filter === 'all' ? rows : rows.filter((r) => r.kind === filter);
  const totalPages = Math.ceil(filtered.length / pageSize);
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <Paper className={buzzClasses.tileCard} id="membership-gifts" p="lg" radius="md">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Title order={4}>Membership Gifts</Title>
        <Group gap="xs" wrap="nowrap">
          {hasBoth && (
            <SegmentedControl
              size="xs"
              value={filter}
              onChange={(value) => {
                setFilter(value as FilterType);
                setPage(1);
              }}
              data={[
                { label: 'All', value: 'all' },
                { label: 'Received', value: 'received' },
                { label: 'Sent', value: 'sent' },
              ]}
            />
          )}
          {showGiftAction && (
            <Button
              component={Link}
              href="/pricing/gift"
              size="compact-sm"
              variant="light"
              leftSection={<IconGift size={14} />}
            >
              Gift a membership
            </Button>
          )}
        </Group>
      </Group>
      <Box mt="md">
        <Stack gap="xs">
          {paginated.map((row) => (
            <GiftRowItem key={`${row.kind}-${row.id}`} row={row} />
          ))}
          {totalPages > 1 && (
            <Center mt="sm">
              <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
            </Center>
          )}
        </Stack>
      </Box>
    </Paper>
  );
}
