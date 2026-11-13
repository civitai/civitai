import { Alert, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCoin } from '@tabler/icons-react';

import { AuthorFeeCard, GOODS_ABSENT, GoodsSalesCard } from '~/components/AppBlocks/RevenuePanel';
import { STANDALONE_KIND_LABEL } from '~/components/Apps/listingKindLabels';
import type { AppEarningsResult } from '~/server/services/blocks/app-collaborator-earnings.service';
import type { AuthorFeeEarnings } from '~/server/services/blocks/author-fee-earnings.service';
import { trpc } from '~/utils/trpc';

/**
 * APP-SCOPED earnings — the collaborator money surface, and the client for
 * `appCollaborators.getAppEarnings`.
 *
 * 🔴 THIS EXISTS BECAUSE THE INVITE DISCLOSURE PROMISES IT. The owner is told, before
 * sending an invitation, that an accepted editor will be able to see this app's Buzz
 * earnings. Until this panel there was no surface behind it, and the proc-↔-client seam
 * guard reported it as wired anyway on the strength of a comment.
 *
 * 🔴 THE PROMISE IS NOT YET TRUE FOR EVERY ACCEPTED EDITOR, and this comment used to
 * claim it was — "TRUE at the API, because the proc grants it to any accepted editor with
 * a session". It does not. `getAppEarnings` is an `appDeveloperProcedure` —
 * `protectedProcedure.use(hasAppBlocksAuthor)` — so it throws FORBIDDEN for any caller
 * outside the `appBlocksAuthor` cohort, accepted editor or not. Such an editor never
 * reaches this panel at all: `getAuthoringContext` carries the same middleware, so the
 * whole page is NotFound for them. What the disclosure describes therefore holds today
 * only for an accepted editor who is ALSO in the author cohort.
 *
 * 🔴 DO NOT SOFTEN THE DISCLOSURE TO MATCH THAT GATE. The reason is no longer "the API
 * already grants it" — that was the retracted claim above — it is that the gate is a
 * RUNTIME Flipt toggle, not a deploy: `appBlocksAuthor` is
 * `{ availability: ['mod'], fliptKey: 'app-blocks-author' }`, and `getFeatureFlags`
 * returns Flipt's answer before it evaluates `availability`, so the cohort can widen with
 * no code change and no PR. Copy softened to today's narrow gate would silently become an
 * UNDER-disclosure the moment someone flips that flag, and an owner would then grant
 * earnings access believing they had not. Widening the gate is a cohort decision; keep the
 * disclosure describing what an accepted editor may see, and do not assume the gate and
 * the disclosure currently agree.
 *
 * 🔴 NOT a variant of `RevenuePanel`. That one drives `blocks.getMyRevenue`, which is
 * keyed on the snapshotted `appOwnerUserId` and is USER-WIDE — pointing it at an editor
 * would show them the owner's ENTIRE PORTFOLIO. This reads ONE listing, resolving the
 * caller's role on it server-side.
 *
 * It renders `RevenuePanel`'s two money cards (author fees, digital goods) over this app's
 * figures, with "on this app" empty copy instead of "attributed to you": the figures are the
 * whole app's, owed to its current owner. The card-purchase revenue share is recorded but
 * never paid out, so it is not shown.
 *
 * The type is imported with `import type`, so nothing from the service's module graph
 * (which reaches `dbRead`) survives into the client bundle.
 */

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

  return (
    <Stack gap="md" data-testid="apps-earnings-panel">
      {/* `data` is a wire payload: an API process older than this bundle omits both keys.
          Absent author fees render as "could not be loaded" and absent goods as the
          unreadable shape, never as zeros. */}
      <AuthorFeeCard
        authorFees={data.authorFees as AuthorFeeEarnings | undefined}
        scoped
        emptyText="No author fees on this app."
      />
      <GoodsSalesCard
        goods={data.goods ?? GOODS_ABSENT}
        scoped
        emptyText="No digital goods sales on this app yet."
      />
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
