import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Tabs,
  Text,
} from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Currency } from '~/shared/utils/prisma/enums';
import type { PromotionSurface } from '~/shared/utils/promotion';
import {
  isPromotionLive,
  promotionRunLabel,
  PROMOTION_QUEUE_LIMIT,
  PROMOTION_SURFACES,
} from '~/shared/utils/promotion';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const TABS = ['received', 'sent'] as const;
type TabValue = (typeof TABS)[number];
const isTabValue = (value: unknown): value is TabValue => TABS.includes(value as TabValue);

const SURFACE_LABEL: Record<PromotionSurface, string> = {
  galleryPromotion: 'Gallery posts',
  modelPromotion: 'Suggested models',
};

type ReceivedRow = RouterOutput['promotion']['getPending'][number];
type SentRow = RouterOutput['promotion']['getMine'][number];

function PromotedThing({ row }: { row: ReceivedRow | SentRow }) {
  if (row.postId)
    return (
      <Anchor component={Link} href={`/posts/${row.postId}`} target="_blank" size="sm">
        a post
      </Anchor>
    );
  if (row.promotedModelId)
    return (
      <Anchor component={Link} href={`/models/${row.promotedModelId}`} target="_blank" size="sm">
        {row.promotedModelName ?? 'a model'}
      </Anchor>
    );
  return <>something that is no longer available</>;
}

function HostPage({ row }: { row: ReceivedRow | SentRow }) {
  return (
    <Anchor component={Link} href={`/models/${row.targetId}`} target="_blank" size="sm">
      {row.hostModelName ?? 'a model page'}
    </Anchor>
  );
}

const runLabel = (days: number | null) => (days ? promotionRunLabel(days) : 'an unknown run');

function QueueCapNote({ count }: { count: number }) {
  if (count < PROMOTION_QUEUE_LIMIT) return null;
  return (
    <Text size="xs" c="dimmed">
      Showing the first {PROMOTION_QUEUE_LIMIT}.
    </Text>
  );
}

/** Promotions waiting on the host's model pages, and the ones this user has bought on others'. */
export function PromotionQueue() {
  const router = useRouter();
  const tab: TabValue = isTabValue(router.query.tab) ? router.query.tab : 'received';
  const [surface, setSurface] = useState<PromotionSurface>('galleryPromotion');

  const setTab = (value: string | null) =>
    router.replace(
      { query: { ...router.query, tab: isTabValue(value) ? value : 'received' } },
      undefined,
      { shallow: true }
    );

  const features = useFeatureFlags();
  const enabled = !!features.creatorPromotions;
  const received = trpc.promotion.getPending.useQuery({ surface }, { enabled });
  const sent = trpc.promotion.getMine.useQuery({ surface }, { enabled });
  const waiting = received.data?.length ?? 0;

  return (
    <Stack gap="md">
      <SegmentedControl
        value={surface}
        onChange={(value) => setSurface(value as PromotionSurface)}
        data={PROMOTION_SURFACES.map((value) => ({ value, label: SURFACE_LABEL[value] }))}
        className="self-start"
      />
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab
            value="received"
            rightSection={
              waiting ? (
                <Badge size="sm" variant="filled" circle>
                  {waiting}
                </Badge>
              ) : null
            }
          >
            Received
          </Tabs.Tab>
          <Tabs.Tab value="sent">Sent</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="received" pt="md">
          <ReceivedTab
            rows={received.data ?? []}
            isLoading={received.isLoading}
            isError={received.isError}
          />
        </Tabs.Panel>
        <Tabs.Panel value="sent" pt="md">
          <SentTab rows={sent.data ?? []} isLoading={sent.isLoading} isError={sent.isError} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function ReceivedTab({
  rows,
  isLoading,
  isError,
}: {
  rows: ReceivedRow[];
  isLoading: boolean;
  isError: boolean;
}) {
  const utils = trpc.useUtils();
  const act = trpc.promotion.act.useMutation({
    onSuccess: (_result, variables) => {
      showSuccessNotification(
        variables.action === 'approve'
          ? { title: 'Accepted', message: 'The promotion is running on your page now.' }
          : { title: 'Declined', message: 'It will not appear on your page.' }
      );
      utils.promotion.invalidate();
    },
    // Accepting re-checks the promotion against your page's settings as they
    // are now, so it can refuse something that was fine when it was sent.
    onError: (error) =>
      showErrorNotification({ title: "Couldn't do that", error: new Error(error.message) }),
  });

  const busyWith = (id: number, action: 'approve' | 'decline') =>
    act.isPending && act.variables?.placementId === id && act.variables?.action === action;

  if (isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  if (isError)
    return (
      <Alert color="red">
        <Text size="sm">Couldn&rsquo;t load your promotions. Refresh to try again.</Text>
      </Alert>
    );
  if (!rows.length)
    return (
      <Alert color="gray">
        <Text size="sm">Nothing is waiting for your review.</Text>
        <Text size="sm" c="dimmed" mt={4}>
          When another creator pays to promote something on one of your model pages, it appears
          here. You choose whether to take promotions and what they cost in{' '}
          <Anchor component={Link} href="/user/account">
            your account settings
          </Anchor>
          .
        </Text>
      </Alert>
    );

  return (
    <Stack gap="md">
      <Text size="xs" c="dimmed">
        Accepting pays you straight away and starts the run. You can&rsquo;t end a promotion once
        you have accepted it.
      </Text>
      <QueueCapNote count={rows.length} />
      {rows.map((row) => (
        <Card key={row.id} withBorder>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Stack gap={4}>
              <Text size="sm">
                <Text span fw={600}>
                  {row.placer?.username ?? 'Someone'}
                </Text>{' '}
                wants to promote <PromotedThing row={row} /> on <HostPage row={row} /> for{' '}
                {runLabel(row.days)}
              </Text>
              <Group gap={4}>
                <CurrencyIcon currency={Currency.BUZZ} size={12} />
                <Text size="xs" c="dimmed">
                  {row.amount}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                Sent {formatDate(row.createdAt)}
                {row.expiresAt ? `, expires ${formatDate(row.expiresAt)}` : ''}
              </Text>
            </Stack>
            <Stack gap={6} className="w-28 shrink-0">
              <Button
                size="compact-sm"
                fullWidth
                leftSection={<IconCheck size={14} />}
                loading={busyWith(row.id, 'approve')}
                disabled={act.isPending}
                onClick={() => act.mutate({ placementId: row.id, action: 'approve' })}
              >
                Accept
              </Button>
              <Button
                size="compact-sm"
                fullWidth
                variant="default"
                leftSection={<IconX size={14} />}
                loading={busyWith(row.id, 'decline')}
                disabled={act.isPending}
                onClick={() => act.mutate({ placementId: row.id, action: 'decline' })}
              >
                Decline
              </Button>
            </Stack>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}

function sentStatus(row: SentRow) {
  if (row.status === 'approved' && row.resolvedAt && row.days) {
    return isPromotionLive({
      acceptedAt: new Date(row.resolvedAt),
      days: row.days,
      endsAt: row.endsAt ?? undefined,
    })
      ? { label: 'Running', color: 'green' }
      : { label: 'Finished', color: 'gray' };
  }
  switch (row.status) {
    case 'pending':
      return { label: 'Waiting for review', color: 'blue' };
    case 'declined':
      return { label: 'Declined', color: 'red' };
    case 'expired':
      return { label: 'Expired', color: 'gray' };
    case 'removed':
      return { label: 'Removed', color: 'gray' };
    default:
      return { label: row.status, color: 'gray' };
  }
}

function SentTab({
  rows,
  isLoading,
  isError,
}: {
  rows: SentRow[];
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading)
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  if (isError)
    return (
      <Alert color="red">
        <Text size="sm">Couldn&rsquo;t load your promotions. Refresh to try again.</Text>
      </Alert>
    );
  if (!rows.length)
    return (
      <Alert color="gray">
        <Text size="sm">You haven&rsquo;t promoted anything yet.</Text>
      </Alert>
    );

  return (
    <Stack gap="md">
      <QueueCapNote count={rows.length} />
      {rows.map((row) => {
        const status = sentStatus(row);
        return (
          <Card key={row.id} withBorder>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={4}>
                <Text size="sm">
                  <PromotedThing row={row} /> on <HostPage row={row} /> for {runLabel(row.days)}
                </Text>
                <Group gap={4}>
                  <CurrencyIcon currency={Currency.BUZZ} size={12} />
                  <Text size="xs" c="dimmed">
                    {row.amount}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed">
                  Sent {formatDate(row.createdAt)}
                </Text>
              </Stack>
              <Badge color={status.color} variant="light">
                {status.label}
              </Badge>
            </Group>
          </Card>
        );
      })}
    </Stack>
  );
}
