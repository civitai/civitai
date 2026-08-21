import { Alert, Card, Center, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCoin } from '@tabler/icons-react';

import { STANDALONE_KIND_LABEL } from '~/components/Apps/listingKindLabels';
import type { AppEarningsResult } from '~/server/services/blocks/app-collaborator-earnings.service';
import { trpc } from '~/utils/trpc';

/**
 * APP-SCOPED earnings — the collaborator money surface, and the client for
 * `appCollaborators.getAppEarnings`.
 *
 * 🔴 THIS EXISTS BECAUSE THE INVITE DISCLOSURE PROMISES IT. The owner is told, before
 * sending an invitation, that an accepted editor will be able to see this app's Buzz
 * earnings — and that promise is TRUE at the API, because the proc grants it to any
 * accepted editor with a session. Until this panel there was no surface behind it, and
 * the proc-↔-client seam guard reported it as wired anyway on the strength of a comment.
 * Softening the copy instead would have been the more dangerous fix: an owner would then
 * grant earnings access believing they had not.
 *
 * 🔴 NOT a variant of `RevenuePanel`. That one drives `blocks.getMyRevenue`, which is
 * keyed on the snapshotted `appOwnerUserId` and is USER-WIDE — pointing it at an editor
 * would show them the owner's ENTIRE PORTFOLIO. This reads ONE listing, resolving the
 * caller's role on it server-side.
 *
 * The type is imported with `import type`, so nothing from the service's module graph
 * (which reaches `dbRead`) survives into the client bundle. That is deliberately unlike
 * `RevenuePanel`, which re-declares its server union locally with a "keep in lockstep"
 * comment — a lockstep nothing enforces.
 */

function dollars(cents: number | null | undefined) {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

type Unavailable = Extract<AppEarningsResult, { ok: false }>['reason'];

/**
 * 🔴 EXHAUSTIVE on the refusal union, enforced by the `never` assignment — the idiom
 * `RevenuePanel`/`AppAnalyticsPanel` already use here. A new reason becomes a COMPILE
 * error rather than confidently-wrong copy on a money screen.
 *
 * Every branch names a REFUSAL, never a zero: `getAppEarnings` returns an explicit reason
 * precisely so "you may not see this" and "this app earned nothing" stay distinguishable.
 * Rendering a zeroed summary for any of these would re-introduce exactly the silent-zero
 * the service refuses to emit.
 */
export function earningsUnavailableMessage(reason: Unavailable): string {
  switch (reason) {
    case 'notPermitted':
      return 'You don’t have access to this app’s earnings.';
    case 'notFound':
      return 'This app listing could not be found.';
    case 'unsupportedKind':
      return `${STANDALONE_KIND_LABEL} apps don’t earn Buzz through Civitai, so there are no earnings to show.`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export type AppEarningsPanelViewProps = {
  data?: AppEarningsResult;
  isLoading?: boolean;
  errorMessage?: string | null;
};

export function AppEarningsPanelView({
  data,
  isLoading = false,
  errorMessage = null,
}: AppEarningsPanelViewProps) {
  if (errorMessage) {
    return (
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        data-testid="apps-earnings-error"
      >
        {errorMessage}
      </Alert>
    );
  }
  if (isLoading || !data) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (!data.ok) {
    return (
      <Alert
        color="gray"
        variant="light"
        icon={<IconCoin size={16} />}
        data-testid={`apps-earnings-unavailable-${data.reason}`}
      >
        {earningsUnavailableMessage(data.reason)}
      </Alert>
    );
  }

  const { summary } = data;
  const cards: Array<{ key: string; label: string; cents: number; count: number; color?: string }> =
    [
      {
        key: 'pending',
        label: 'Pending',
        cents: summary.pending.shareCents,
        count: summary.pending.count,
      },
      {
        key: 'confirmed',
        label: 'Confirmed (unpaid)',
        cents: summary.confirmed.shareCents,
        count: summary.confirmed.count,
        color: 'green',
      },
      {
        key: 'paidOut',
        label: 'Paid out',
        cents: summary.paidOut.shareCents,
        count: summary.paidOut.count,
      },
      {
        key: 'voided',
        label: 'Voided',
        cents: summary.voided.grossCents,
        count: summary.voided.count,
        color: 'dimmed',
      },
    ];

  return (
    <Stack gap="md" data-testid="apps-earnings-panel">
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
        {cards.map((card) => (
          <Card
            key={card.key}
            padding="md"
            radius="md"
            withBorder
            data-testid={`apps-earnings-${card.key}`}
          >
            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
              {card.label}
            </Text>
            <Title order={3} mt={4} c={card.color}>
              {dollars(card.cents)}
            </Title>
            <Text size="xs" c="dimmed">
              {card.count} purchase{card.count === 1 ? '' : 's'}
            </Text>
          </Card>
        ))}
      </SimpleGrid>
      {/* 🔴 The scope is stated on screen. An EDITOR reaching this panel is seeing ONE
          app's figures, never the owner's portfolio — and saying so is what stops the
          number being read as "everything this owner earns". */}
      <Group gap={6}>
        <IconCoin size={14} />
        <Text size="xs" c="dimmed" data-testid="apps-earnings-scope-note">
          These figures cover this app only
          {data.role === 'editor' ? ', and are shared with everyone seated on it' : ''}.
        </Text>
      </Group>
    </Stack>
  );
}

export function AppEarningsPanel({ appListingId }: { appListingId: string }) {
  const query = trpc.appCollaborators.getAppEarnings.useQuery({ appListingId }, { retry: false });
  return (
    <AppEarningsPanelView
      data={query.data as AppEarningsResult | undefined}
      isLoading={query.isLoading}
      errorMessage={query.error?.message ?? null}
    />
  );
}
