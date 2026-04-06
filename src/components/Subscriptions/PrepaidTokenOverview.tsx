import {
  Badge,
  Box,
  Button,
  Card,
  Collapse,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import {
  IconBolt,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconLock,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import dayjs from 'dayjs';
import type { PrepaidToken, SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

const TIER_COLORS: Record<string, string> = {
  bronze: 'orange',
  silver: 'gray',
  gold: 'yellow',
};

/**
 * Fetches historical prepaid buzz deliveries from ClickHouse in a single query.
 * Deduplicates against existing tokens from the prepaid token system.
 */
function useHistoricalPrepaidDeliveries({
  subscription,
  existingTokens,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscription: any;
  existingTokens: PrepaidToken[];
}): {
  history: PrepaidToken[];
  isLoading: boolean;
} {
  const isCivitai = subscription?.product?.provider === 'Civitai';
  const buzzType =
    (subscription?.product?.metadata as SubscriptionProductMetadata)?.buzzType ?? 'yellow';
  const accountType = buzzType === 'green' ? ('green' as const) : ('yellow' as const);

  const { data, isLoading } = trpc.subscriptions.getHistoricalPrepaidDeliveries.useQuery(
    { accountType },
    { enabled: isCivitai }
  );

  const history = useMemo(() => {
    if (!data || data.length === 0) return [];

    const existingTxIds = new Set(
      existingTokens.filter((t) => t.buzzTransactionId).map((t) => t.buzzTransactionId!)
    );

    return data.filter((t) => !existingTxIds.has(t.buzzTransactionId ?? ''));
  }, [data, existingTokens]);

  return {
    history,
    isLoading: isCivitai && isLoading,
  };
}

function TokenCard({ token, onClaimed }: { token: PrepaidToken; onClaimed?: () => void }) {
  const claimMutation = trpc.subscriptions.claimPrepaidToken.useMutation({
    onSuccess: (data) => {
      showSuccessNotification({
        title: 'Token Claimed!',
        message: `${data.buzzAmount.toLocaleString()} Buzz has been added to your account.`,
      });
      onClaimed?.();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to claim token',
        error: new Error(error.message),
      });
    },
  });

  if (token.status === 'unlocked') {
    return (
      <Card
        p="sm"
        radius="md"
        withBorder
        style={{
          borderColor: 'var(--mantine-color-yellow-9)',
          backgroundColor: 'rgba(252, 156, 45, 0.06)',
        }}
      >
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="sm" align="center" wrap="nowrap">
            <ThemeIcon color="yellow" variant="light" size="md" radius="xl">
              <IconBolt size={16} />
            </ThemeIcon>
            <Stack gap={1}>
              <Group gap={6}>
                <Badge size="xs" color={TIER_COLORS[token.tier]} variant="filled">
                  {token.tier}
                </Badge>
                {token.unlockedAt && (
                  <Text size="xs" c="dimmed">
                    {dayjs(token.unlockedAt).format('MMM D, YYYY')}
                  </Text>
                )}
              </Group>
              <Text size="sm" fw={600} c="yellow">
                {token.buzzAmount.toLocaleString()} Buzz
              </Text>
            </Stack>
          </Group>
          <Button
            size="xs"
            color="yellow"
            variant="filled"
            leftSection={<IconBolt size={14} />}
            loading={claimMutation.isPending}
            onClick={() => claimMutation.mutate({ tokenId: token.id })}
            style={{ color: 'var(--mantine-color-dark-9)' }}
          >
            Claim
          </Button>
        </Group>
      </Card>
    );
  }

  if (token.status === 'claimed') {
    return (
      <Card
        p="sm"
        radius="md"
        withBorder
        opacity={0.7}
        style={{
          borderColor: 'rgba(252, 156, 45, 0.15)',
          backgroundColor: 'rgba(252, 156, 45, 0.02)',
        }}
      >
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="sm" align="center" wrap="nowrap">
            <ThemeIcon color="yellow" variant="light" size="md" radius="xl">
              <IconCircleCheck size={16} />
            </ThemeIcon>
            <Stack gap={1}>
              <Group gap={6}>
                <Badge size="xs" color={TIER_COLORS[token.tier]} variant="filled">
                  {token.tier}
                </Badge>
              </Group>
              <Text size="sm" c="yellow" opacity={0.7}>
                {token.buzzAmount.toLocaleString()} Buzz
              </Text>
            </Stack>
          </Group>
          <Stack gap={2} align="flex-end">
            <Group gap={4}>
              <IconCircleCheck size={14} color="var(--mantine-color-yellow-5)" />
              <Text size="xs" c="yellow">
                Claimed
              </Text>
            </Group>
            {(token.claimedAt || token.unlockedAt) && (
              <Text size="xs" c="dimmed">
                {dayjs(token.claimedAt ?? token.unlockedAt).format('MMM D, YYYY')}
              </Text>
            )}
          </Stack>
        </Group>
      </Card>
    );
  }

  // Locked
  return (
    <Card p="sm" radius="md" withBorder>
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="sm" align="center" wrap="nowrap">
          <ThemeIcon color="gray" variant="light" size="md" radius="xl">
            <IconLock size={16} />
          </ThemeIcon>
          <Stack gap={1}>
            <Group gap={6}>
              <Badge size="xs" color={TIER_COLORS[token.tier]} variant="filled">
                {token.tier}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {token.buzzAmount.toLocaleString()} Buzz
            </Text>
          </Stack>
        </Group>
        <Group gap={4}>
          <IconLock size={14} color="var(--mantine-color-dark-3)" />
          <Text size="xs" c="dimmed">
            Locked
          </Text>
        </Group>
      </Group>
    </Card>
  );
}

export function PrepaidTokenOverview({
  tokens,
  nextUnlockDate,
  onTokensClaimed,
  defaultExpanded = false,
  subscription,
}: {
  tokens: PrepaidToken[];
  nextUnlockDate?: Date | null;
  onTokensClaimed?: () => void;
  /** When true, locked and claimed sections start expanded */
  defaultExpanded?: boolean;
  /** Pass the subscription object to show historical prepaid buzz deliveries */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscription?: any;
}) {
  const [lockedOpen, setLockedOpen] = useState(defaultExpanded);
  const [claimedOpen, setClaimedOpen] = useState(defaultExpanded);

  const utils = trpc.useUtils();

  const claimAllMutation = trpc.subscriptions.claimAllPrepaidTokens.useMutation({
    onSuccess: (data) => {
      showSuccessNotification({
        title: 'All Tokens Claimed!',
        message: `${data.totalBuzz.toLocaleString()} Buzz from ${data.claimed} tokens has been added to your account.`,
      });
      utils.subscriptions.getUserSubscription.invalidate();
      onTokensClaimed?.();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to claim tokens',
        error: new Error(error.message),
      });
    },
  });

  const handleSingleClaim = () => {
    utils.subscriptions.getUserSubscription.invalidate();
    onTokensClaimed?.();
  };

  // Fetch historical prepaid deliveries from ClickHouse (single query, deduplicated)
  const {
    history: historicalDeliveries,
    isLoading: historyLoading,
  } = useHistoricalPrepaidDeliveries({
    subscription,
    existingTokens: tokens,
  });

  const unlocked = tokens.filter((t) => t.status === 'unlocked');
  const locked = tokens.filter((t) => t.status === 'locked');
  // Combine new-system claimed tokens with historical deliveries
  const newClaimed = tokens.filter((t) => t.status === 'claimed');
  const claimed = [...newClaimed, ...historicalDeliveries];

  const unlockedBuzz = unlocked.reduce((sum, t) => sum + t.buzzAmount, 0);
  const claimedBuzz = claimed.reduce((sum, t) => sum + t.buzzAmount, 0);

  // Don't render empty shell
  const hasAnything = unlocked.length > 0 || locked.length > 0 || claimed.length > 0 || historyLoading;
  if (!hasAnything) return null;

  return (
    <Stack gap="md">
      {/* Claim Banner */}
      {unlocked.length > 0 && (
        <Card
          p="md"
          radius="md"
          style={{
            background: 'linear-gradient(135deg, rgba(252, 156, 45, 0.12) 0%, rgba(252, 156, 45, 0.04) 100%)',
            borderColor: 'rgba(252, 156, 45, 0.3)',
            borderWidth: 1,
            borderStyle: 'solid',
          }}
        >
          <Group justify="space-between" align="center" wrap="nowrap">
            <Group gap="md" align="center" wrap="nowrap">
              <ThemeIcon color="yellow" size="xl" radius="xl">
                <IconBolt size={22} />
              </ThemeIcon>
              <Stack gap={2}>
                <Text size="xs" fw={600} c="yellow">
                  Ready to claim
                </Text>
                <Text size="lg" fw={700}>
                  {unlocked.length} token{unlocked.length !== 1 ? 's' : ''} · {unlockedBuzz.toLocaleString()} Buzz
                </Text>
              </Stack>
            </Group>
            <Group gap="md" align="center" wrap="nowrap">
              {locked.length > 0 && (
                <Group gap={6} visibleFrom="sm">
                  <IconLock size={13} color="var(--mantine-color-dimmed)" />
                  <Text size="xs" c="dimmed">
                    {locked.length} locked{nextUnlockDate ? ` · next ${dayjs(nextUnlockDate).format('MMM D')}` : ''}
                  </Text>
                </Group>
              )}
              <Button
                color="yellow"
                leftSection={<IconBolt size={16} />}
                loading={claimAllMutation.isPending}
                onClick={() => claimAllMutation.mutate()}
                style={{ color: 'var(--mantine-color-dark-9)' }}
              >
                Claim All
              </Button>
            </Group>
          </Group>
        </Card>
      )}

      {/* Unlocked Token Cards */}
      {unlocked.length > 0 && (
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 'var(--mantine-spacing-xs)',
          }}
        >
          {unlocked.map((token) => (
            <TokenCard key={token.id} token={token} onClaimed={handleSingleClaim} />
          ))}
        </Box>
      )}

      {/* Locked Section (Collapsed) */}
      {locked.length > 0 && (
        <Stack gap="xs">
          <UnstyledButton onClick={() => setLockedOpen((o) => !o)}>
            <Card p="sm" radius="md" withBorder>
              <Group justify="space-between" align="center">
                <Group gap="sm">
                  {lockedOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                  <IconLock size={14} color="var(--mantine-color-dimmed)" />
                  <Text size="sm" fw={600} c="dimmed">
                    {locked.length} Locked
                  </Text>
                </Group>
                <Text size="xs" c="dimmed">
                  Next unlock: {nextUnlockDate ? dayjs(nextUnlockDate).format('MMM D, YYYY') : ''}
                </Text>
              </Group>
            </Card>
          </UnstyledButton>
          <Collapse in={lockedOpen}>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: 'var(--mantine-spacing-xs)',
              }}
            >
              {locked.map((token) => (
                <TokenCard key={token.id} token={token} />
              ))}
            </Box>
          </Collapse>
        </Stack>
      )}

      {/* Claimed Section (Collapsed) */}
      {(claimed.length > 0 || historyLoading) && (
        <Stack gap="xs">
          <UnstyledButton onClick={() => setClaimedOpen((o) => !o)}>
            <Card p="sm" radius="md" withBorder>
              <Group justify="space-between" align="center">
                <Group gap="sm">
                  {claimedOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                  <IconCircleCheck size={14} color="var(--mantine-color-yellow-5)" />
                  <Text size="sm" fw={600} c="yellow">
                    {historyLoading
                      ? 'Loading history...'
                      : claimed.length > 0
                        ? `${claimed.length} Claimed`
                        : 'Claim History'}
                  </Text>
                  {historyLoading && <Loader size={14} color="yellow" />}
                </Group>
                {!historyLoading && (
                  <Text size="xs" c="dimmed">
                    {claimedBuzz.toLocaleString()} Buzz
                  </Text>
                )}
              </Group>
            </Card>
          </UnstyledButton>
          <Collapse in={claimedOpen}>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: 'var(--mantine-spacing-xs)',
              }}
            >
              {claimed.map((token) => (
                <TokenCard key={token.id} token={token} />
              ))}
            </Box>
          </Collapse>
        </Stack>
      )}

    </Stack>
  );
}
