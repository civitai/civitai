import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Stack,
  Table,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconHistory,
  IconInfoCircle,
  IconRefresh,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import type { OffsitePendingRow } from '~/components/Apps/OffsiteReviewQueue';
import { canRetriggerBuild } from '~/components/Apps/deploy-status';
import type { BuildAttemptSignals } from '~/shared/constants/app-block-build.constants';
import { AppsTableColgroup, APPS_REVIEW_QUEUE_COLUMNS } from '~/components/Apps/appsWideLayout';
import { getPlayCountLabel } from '~/components/Apps/appListingCardView';
import { STANDALONE_KIND_LABEL } from '~/components/Apps/listingKindLabels';
import { ListingIconThumb } from '~/components/Apps/ListingMediaThumb';
import {
  compactRelativeTime,
  REVIEW_RELATIVE_TICK_MS,
  useNowTick,
} from '~/components/Apps/reviewRelativeTime';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import {
  failedBuildSummary,
  mergeReviewRows,
  offsiteRequestToUnifiedRow,
  onsiteRequestToUnifiedRow,
  type CombinedReviewPayload,
  type OffsiteReviewRequest,
  type OnsiteReviewRequest,
  type UnifiedReviewRow,
} from '~/components/Apps/unifiedReviewRow';

/**
 * ONE list interleaving the on-site + off-site moderator review sources for a tab
 * (Pending / Approved / Rejected). Normalizes each source's rows through the pure
 * adapters, merges + sorts them with `mergeReviewRows`, and renders a single table
 * with a per-row KIND badge and a Review/View action wired to the CORRECT modal.
 *
 * Presentational: the two tRPC queries + their keyset pagination live in the
 * per-tab wrapper (in `src/pages/apps/review.tsx`); this component receives the
 * already-accumulated raw items + loading/error/hasMore state and the two
 * page-owned open callbacks. It opens NO query of its own — keep it that way.
 *
 * ⚠️ IT IS NO LONGER RENDERABLE FROM `renderWithProviders` ALONE: the Submitter cell's
 * `UserAvatar` reaches `useFeatureFlags`, `useCurrentUser`,
 * `useViewerBrowsingLevelDebounced` and `useBrowsingSettings`, so a browser suite that
 * mounts this list has to supply those — by stubbing the avatar, or (where the painted
 * width is the thing under test) by stubbing the hooks and keeping the real component.
 */

/** What the version cell hands the page when a moderator asks for an app's history. */
export type VersionHistoryTarget = {
  slug: string;
  /** The entry in that history the moderator is looking at, so the modal can mark it. */
  currentRequestId: string | null;
  /** The app's display name — the modal shows it beside the slug, and the trigger uses it
   *  for its own accessible name. */
  title: string;
};

/*
 * 🔴 THE TICK AND ITS HOOK MOVED TO `reviewRelativeTime.ts`, beside the ladder they drive.
 * `REVIEW_RELATIVE_TICK_MS` is re-exported here because this module's own tests and the
 * `/apps/review` page import it from this path; the rationale (one timer for the whole list,
 * and why a minute is the floor) now lives on the hook.
 */
export { REVIEW_RELATIVE_TICK_MS };

/**
 * What the Plays column does and does not mean.
 *
 * 🔴 THE KIND WORD IS INTERPOLATED FROM `STANDALONE_KIND_LABEL`, never spelled. A literal
 * here is precisely what `__tests__/standaloneWordingCallSites.test.ts` reds on, and it
 * caught this string carrying the retired wording.
 *
 * 🔴 THE NUMBER IS NOT PUBLIC USAGE AND NOTHING ELSE ON SCREEN SAYS SO. The cell's wording
 * comes from `getPlayCountLabel`, shared with the public store card, so it cannot be
 * reworded here without the two surfaces disagreeing about one listing — the caveats go
 * here instead.
 *
 * 🔴 IT DESCRIBES THE COUNTER, NEVER ITS AUDIENCE. The run page is gated by
 * `app-blocks-pages-enabled`; naming who is in that segment would be false the day it
 * widens, with nothing to tell you. Read that flag's current rollout to interpret the
 * figure — this string stays true either way.
 */
export const PLAYS_CAVEAT =
  "Store opens of this app's run page. NOT deduplicated — crawlers and link unfurlers are " +
  'counted too, so read it as an upper bound rather than unique users. The run page is ' +
  `still flag-limited, so this reflects internal opens rather than public traffic. A ` +
  `${STANDALONE_KIND_LABEL} listing can never record one: its CTA leaves the site, so an ` +
  'em dash there means unmeasurable, not zero.';

export function UnifiedReviewList({
  onsiteItems,
  offsiteItems,
  direction,
  openOnsiteReview,
  openOffsiteReview,
  openCombinedReview,
  openVersionHistory,
  isLoading,
  errorMessage,
  emptyLabel,
  dateLabel,
  actionLabel,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onRetriggerBuild,
  retriggeringId,
}: {
  onsiteItems: OnsiteReviewRequest[];
  offsiteItems: OffsiteReviewRequest[];
  direction: 'asc' | 'desc';
  /** Opens the ON-SITE modal for an on-site row (page-owned; may be pre-bound to
   *  the tab's review mode). */
  openOnsiteReview: (req: OnsiteReviewRequest) => void;
  /** Opens the OFF-SITE modal for an off-site row (page-owned). */
  openOffsiteReview: (row: OffsitePendingRow) => void;
  /** Opens the COMBINED code+media surface (page-owned). When provided, an app with
   *  BOTH a pending code request AND a pending listing-media revision collapses into
   *  ONE combined row (PENDING tab only). Omitted on history tabs → no combining. */
  openCombinedReview?: (payload: CombinedReviewPayload) => void;
  /** Opens the PRIOR-VERSIONS modal for a row's app (page-owned, like every other modal
   *  this list opens). Omitted → the version cell renders without a trigger. */
  openVersionHistory?: (target: VersionHistoryTarget) => void;
  isLoading: boolean;
  /** Non-empty when EITHER source query errored transiently — surfaced as an Alert
   *  rather than silently blanking the list. */
  errorMessage?: string;
  emptyLabel: string;
  /** Column header for the row timestamp ("Submitted" for pending, "Reviewed" for
   *  history) — the value itself is chosen by the adapter. */
  dateLabel: string;
  /** Row action label ("Review" for pending, "View" for history). */
  actionLabel: string;
  hasMore: boolean;
  isLoadingMore?: boolean;
  onLoadMore: () => void;
  /** APPROVED tab only. When provided, rows that carry a deploy projection render a
   *  Deploy column (including the STRANDED "build never started" state) plus a
   *  "Retrigger build" control wired to `blocks.retriggerBuild`. Omitted on the
   *  Pending/Rejected tabs, where neither exists — so those tabs are unchanged. */
  onRetriggerBuild?: (publishRequestId: string) => void;
  /** The publish-request id currently being re-triggered — disables + spins ITS
   *  button only, so a double-click cannot fire the mutation twice client-side. */
  retriggeringId?: string | null;
}) {
  const rows = useMemo(() => {
    const onsiteRows = onsiteItems.map((r) => onsiteRequestToUnifiedRow(r, openOnsiteReview));
    const offsiteRows = offsiteItems.map((r) => offsiteRequestToUnifiedRow(r, openOffsiteReview));
    return mergeReviewRows(onsiteRows, offsiteRows, direction, openCombinedReview);
  }, [
    onsiteItems,
    offsiteItems,
    direction,
    openOnsiteReview,
    openOffsiteReview,
    openCombinedReview,
  ]);

  // The Deploy column exists only where a retrigger handler was supplied (the
  // Approved tab). Pending/Rejected render exactly as before.
  const showDeploy = !!onRetriggerBuild;

  /**
   * 🔴 NO `useIsClient` GATE, unlike `DaysFromNow`. `/apps/review`'s `getServerSideProps`
   * passes no data and the table sits behind `rows.length > 0`, so nothing renders on the
   * server — there is no first paint for a tick to disagree with.
   */
  const now = useNowTick(REVIEW_RELATIVE_TICK_MS);

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm" data-testid="apps-unified-review-count">
        {isLoading && rows.length === 0 ? 'Loading…' : `${rows.length}${hasMore ? '+' : ''} shown.`}
      </Text>

      {errorMessage && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {errorMessage}
        </Alert>
      )}

      {!isLoading && rows.length === 0 && !errorMessage && (
        <Card withBorder p="lg">
          <Group gap="xs">
            <IconCheck color="var(--mantine-color-green-6)" size={20} />
            <Text>{emptyLabel}</Text>
          </Group>
        </Card>
      )}

      {rows.length > 0 && (
        <Card withBorder p={0}>
          <Table verticalSpacing="md" horizontalSpacing="md">
            {/*
              🔴 FIRST CHILD, BEFORE the row groups — HTML requires it there, and
              `__tests__/appsWideLayout.test.ts` is what enforces it (see the note on that
              guard for what the PIXELS can and cannot see about the ordering). Its ledger
              is keyed on `showDeploy`, i.e. on the same DATA that decides whether the
              Deploy column exists, so the two can never disagree about the column COUNT.
              Why this table has one at all: `/apps/review` used to cap its whole page at
              1368 because these columns could not spend the container and the Review
              button drifted away from its row.
            */}
            <AppsTableColgroup
              columns={
                showDeploy
                  ? APPS_REVIEW_QUEUE_COLUMNS.withDeploy
                  : APPS_REVIEW_QUEUE_COLUMNS.withoutDeploy
              }
            />
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Kind</Table.Th>
                {/* The PRIMARY column — no width in the ledger, so it takes the slack.
                    The testid is what `AppsWideLayout.geometry.test.tsx` measures. */}
                <Table.Th data-testid="apps-unified-review-col-app">App</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Submitter</Table.Th>
                {/* 🔴 THE CAVEATS RIDE A NATIVE `title`, NOT A POPOVER. An
                    `InfoPopover` renders a real button, and this list's own poll suite
                    asserts that every button inside the tab is one the LIST emitted with an
                    `apps-unified-review-` testid — which `InfoPopover` has no typed way to
                    pass. A `title` needs no control, is announced by screen readers, and
                    survives with no JS. */}
                <Table.Th title={PLAYS_CAVEAT}>
                  <Group gap={4} wrap="nowrap" style={{ cursor: 'help' }}>
                    Plays
                    <IconInfoCircle size={13} style={{ opacity: 0.6 }} aria-hidden />
                  </Group>
                </Table.Th>
                <Table.Th>{dateLabel}</Table.Th>
                {showDeploy && <Table.Th>Deploy</Table.Th>}
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <UnifiedReviewRowView
                  key={row.key}
                  row={row}
                  now={now}
                  actionLabel={actionLabel}
                  showDeploy={showDeploy}
                  onRetriggerBuild={onRetriggerBuild}
                  retriggeringId={retriggeringId ?? null}
                  openVersionHistory={openVersionHistory}
                />
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      {hasMore && (
        <Group justify="center">
          <Button
            variant="default"
            onClick={onLoadMore}
            loading={isLoadingMore}
            disabled={isLoadingMore}
            data-testid="apps-unified-review-load-more"
          >
            Load more
          </Button>
        </Group>
      )}
    </Stack>
  );
}

/**
 * Deploy-state chip for an on-site APPROVED row. The point of this column is the
 * `null` case: an approval whose build never started looked, until now, exactly
 * like a healthy one in the mod queue.
 */
function DeployStateChip({
  state,
  rowKey,
  buildSignals,
}: {
  state: string | null;
  rowKey: string;
  buildSignals?: BuildAttemptSignals | null;
}) {
  const testId = `apps-unified-review-deploy-${rowKey}`;
  if (state === null || state === undefined) {
    return (
      <Badge
        size="sm"
        color="orange"
        variant="light"
        leftSection={<IconAlertTriangle size={11} />}
        title="No build was ever recorded for this approval — the build most likely never started."
        data-testid={testId}
      >
        never built
      </Badge>
    );
  }
  const color =
    state === 'live'
      ? 'green'
      : state === 'failed'
      ? 'red'
      : state.startsWith('preview-')
      ? 'grape'
      : 'blue';
  // A failed build names its step and class: structured fields, never the excerpt.
  const summary = state === 'failed' ? failedBuildSummary(buildSignals) : null;
  return (
    <Badge size="sm" color={color} variant="light" data-testid={testId}>
      {summary ? `${state} · ${summary}` : state}
    </Badge>
  );
}

/**
 * "Retrigger build" — re-fires the Tekton build for an already-approved request
 * using its STORED commit sha (the mutation takes only the request id).
 *
 * Two independent double-fire guards, because a duplicated PipelineRun is the
 * failure mode here:
 *   1. `armed` — the first click asks for confirmation, the second fires. A stray
 *      double-click therefore arms-then-fires ONCE rather than firing twice.
 *   2. `busy` — while the mutation for THIS row is in flight the button is both
 *      `disabled` and `loading`.
 * The server holds the authoritative guard anyway (a per-request redis NX lock).
 */
function RetriggerBuildButton({
  publishRequestId,
  disabled,
  busy,
  onRetrigger,
  rowKey,
}: {
  publishRequestId: string;
  disabled: boolean;
  busy: boolean;
  onRetrigger: (publishRequestId: string) => void;
  rowKey: string;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      size="compact-xs"
      variant={armed ? 'filled' : 'default'}
      color={armed ? 'orange' : undefined}
      leftSection={<IconRefresh size={12} />}
      disabled={disabled || busy}
      loading={busy}
      title={
        disabled
          ? 'This version is deployed (or a build is still running) — nothing to re-trigger.'
          : 'Re-run the build for the commit that was already approved.'
      }
      data-testid={`apps-unified-review-retrigger-${rowKey}`}
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        // The row's other cells open the review modal on click; this control must
        // not also do that.
        e.stopPropagation();
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onRetrigger(publishRequestId);
      }}
    >
      {armed ? 'Confirm rebuild' : 'Retrigger build'}
    </Button>
  );
}

/**
 * The submitted CODE version, plus the loud `first version` flag, plus the trigger into
 * that app's prior-version history.
 *
 * 🔴 THE BADGE WORDING AND COLOUR ARE `OnsiteReviewModalTitle`'s, to the letter. The queue
 * and the review surface a moderator opens from it must not spell the same verdict two ways
 * — a second spelling is how the two come to disagree about what it means.
 */
function VersionCell({
  row,
  openVersionHistory,
}: {
  row: UnifiedReviewRow;
  openVersionHistory?: (target: VersionHistoryTarget) => void;
}) {
  // A listing revision ships no code: `—`, never the badge, and nothing to open.
  if (!row.version) {
    return (
      <Text size="xs" c="dimmed" data-testid={`apps-unified-review-version-${row.key}`}>
        —
      </Text>
    );
  }
  const body = (
    // 🔴 `nowrap` for the same reason as the kind badge: this cell is a semver NEXT TO a
    // badge, and letting the pair break across lines grows the row.
    <Group gap={6} wrap="nowrap" data-testid={`apps-unified-review-version-${row.key}`}>
      <Code>{row.version}</Code>
      {row.isFirstVersion && (
        <Badge
          color="violet"
          size="sm"
          style={{ whiteSpace: 'nowrap' }}
          data-testid={`apps-unified-review-first-version-${row.key}`}
        >
          first version
        </Badge>
      )}
    </Group>
  );
  if (!openVersionHistory) return body;
  return (
    <UnstyledButton
      data-testid={`apps-unified-review-version-trigger-${row.key}`}
      aria-label={`Prior versions of ${row.title}`}
      title="Every submission for this app, newest first."
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        // Every other cell in this row opens the review; this one must not also do that.
        e.stopPropagation();
        openVersionHistory({
          slug: row.slug ?? '',
          currentRequestId: row.publishRequestId ?? null,
          title: row.title,
        });
      }}
    >
      <Group gap={4} wrap="nowrap">
        {body}
        <IconHistory size={12} style={{ opacity: 0.6 }} />
      </Group>
    </UnstyledButton>
  );
}

function UnifiedReviewRowView({
  row,
  now,
  actionLabel,
  showDeploy,
  onRetriggerBuild,
  retriggeringId,
  openVersionHistory,
}: {
  row: UnifiedReviewRow;
  now: Date;
  actionLabel: string;
  showDeploy: boolean;
  onRetriggerBuild?: (publishRequestId: string) => void;
  retriggeringId: string | null;
  openVersionHistory?: (target: VersionHistoryTarget) => void;
}) {
  const submitter = row.submitter;
  const deploy = row.deploy;
  const playLabel = getPlayCountLabel(row.playCount);
  const absolute = row.submittedAt.toLocaleString();
  const iso = Number.isFinite(row.submittedAt.getTime())
    ? row.submittedAt.toISOString()
    : undefined;
  return (
    <Table.Tr style={{ cursor: 'pointer' }} data-testid={`apps-unified-review-row-${row.key}`}>
      <Table.Td onClick={row.onReview}>
        <Badge
          size="sm"
          variant="light"
          // 🔴 `nowrap` — this column's ledger share sits below its content on purpose, and
          // that only works when min-content is the WHOLE label. A one-word kind badge
          // broke across lines and the row grew; see the height invariant in
          // `AppsWideLayout.geometry.test.tsx`.
          style={{ whiteSpace: 'nowrap' }}
          color={row.badgeColor}
          data-testid={`apps-unified-review-kind-${row.key}`}
        >
          {row.badge}
        </Badge>
      </Table.Td>
      <Table.Td onClick={row.onReview}>
        {/* The icon lives INSIDE this cell rather than in a column of its own: a 40px
            image cannot use a column's share, so a sixth fixed column would take width
            off the primary one to pad a fixed-size box.

            🔴 NOT CLICKABLE, AND THAT IS THE DECISION RATHER THAN AN OMISSION. Passing no
            `onOpen` leaves it a plain `<img>`: judging store media at 40px is worse than
            opening the submission, which is one click away and shows the icon AND the cover
            at full size (`ReviewListingMedia`). A lightbox here would also be the only
            interactive child in a whole-row-clickable cell, i.e. a second thing one click
            could do. */}
        <Group gap="sm" wrap="nowrap">
          <ListingIconThumb
            url={row.iconUrl}
            name={row.title}
            imgTestId={`apps-unified-review-icon-${row.key}`}
            placeholderTestId={`apps-unified-review-icon-placeholder-${row.key}`}
          />
          <Stack gap={0} style={{ minWidth: 0 }}>
            {row.slug && <Code>{row.slug}</Code>}
            {row.title && row.title !== row.slug && (
              <Text size="xs" c="dimmed">
                {row.title}
              </Text>
            )}
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td onClick={row.onReview}>
        <VersionCell row={row} openVersionHistory={openVersionHistory} />
      </Table.Td>
      <Table.Td onClick={row.onReview}>
        {submitter?.username ? (
          /*
            🔴 `stopPropagation` AROUND THE CHIP, not on the cell, because `linkToProfile`
            renders a real `<a>` inside a cell whose click opens the review: without it one
            click BOTH navigates to the profile and opens the review surface behind it.
            Scoped to the chip so the rest of the cell still opens the review, like every
            other cell in the row.
          */
          <span
            onClick={(e: React.MouseEvent<HTMLSpanElement>) => e.stopPropagation()}
            data-testid={`apps-unified-review-submitter-${row.key}`}
          >
            {/*
              🔴 `user=`, NOT `userId=`. The row already carries `{id, username, image}`, so
              the `userId` form's `trpc.user.getById` per distinct submitter is pure waste.
              It buys nothing either: that path hardcodes `cosmetics: []`, so neither form
              renders a decoration frame.
            */}
            <UserAvatar user={submitter} size="sm" withUsername linkToProfile />
          </span>
        ) : (
          /* A submitter with no username is still an identity a moderator can act on, and
             a deleted one must not render as an empty cell — the same two fallbacks this
             cell showed as plain text before the avatar. */
          <Text size="xs" c="dimmed" data-testid={`apps-unified-review-submitter-${row.key}`}>
            {submitter ? `#${submitter.id}` : '—'}
          </Text>
        )}
      </Table.Td>
      <Table.Td onClick={row.onReview}>
        {/* `getPlayCountLabel` returns null for 0 ON PURPOSE (an absent count and a zero
            count are both "nothing happened yet" on screen) — honour it rather than
            rendering "0 plays". See `UnifiedReviewRow.playCount` for what this number
            does and does not mean. */}
        <Text
          size="xs"
          c={playLabel ? undefined : 'dimmed'}
          style={{ whiteSpace: 'nowrap' }}
          data-testid={`apps-unified-review-plays-${row.key}`}
        >
          {playLabel ?? '—'}
        </Text>
      </Table.Td>
      <Table.Td onClick={row.onReview}>
        {/* Same reason as the kind badge: an age is one token and must not wrap. The exact
            timestamp stays reachable on hover + to a screen reader via `title`/`dateTime`,
            which is what makes a relative label safe to show a moderator. */}
        <Group gap={4} wrap="nowrap">
          <IconClock size={14} />
          <Text size="xs" style={{ whiteSpace: 'nowrap' }}>
            <time
              dateTime={iso}
              title={absolute}
              data-testid={`apps-unified-review-age-${row.key}`}
            >
              {compactRelativeTime(row.submittedAt, now)}
            </time>
          </Text>
        </Group>
      </Table.Td>
      {showDeploy && (
        <Table.Td>
          {deploy ? (
            <Stack gap={4} align="flex-start">
              <DeployStateChip
                state={deploy.state}
                rowKey={row.key}
                buildSignals={deploy.buildSignals}
              />
              {onRetriggerBuild && (
                <RetriggerBuildButton
                  publishRequestId={deploy.publishRequestId}
                  rowKey={row.key}
                  disabled={!canRetriggerBuild(deploy)}
                  busy={retriggeringId === deploy.publishRequestId}
                  onRetrigger={onRetriggerBuild}
                />
              )}
            </Stack>
          ) : (
            <Text size="xs" c="dimmed">
              —
            </Text>
          )}
        </Table.Td>
      )}
      <Table.Td>
        <Button
          size="xs"
          variant="default"
          onClick={row.onReview}
          rightSection={<IconExternalLink size={12} />}
          data-testid={`apps-unified-review-action-${row.key}`}
        >
          {actionLabel}
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}
