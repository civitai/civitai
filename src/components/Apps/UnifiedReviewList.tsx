import { Alert, Badge, Button, Card, Code, Group, Stack, Table, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconRefresh,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import type { OffsitePendingRow } from '~/components/Apps/OffsiteReviewQueue';
import { canRetriggerBuild } from '~/components/Apps/deploy-status';
import {
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
 * page-owned open callbacks. Keep it server-graph-free so it is browser-testable.
 */
export function UnifiedReviewList({
  onsiteItems,
  offsiteItems,
  direction,
  openOnsiteReview,
  openOffsiteReview,
  openCombinedReview,
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
  }, [onsiteItems, offsiteItems, direction, openOnsiteReview, openOffsiteReview, openCombinedReview]);

  // The Deploy column exists only where a retrigger handler was supplied (the
  // Approved tab). Pending/Rejected render exactly as before.
  const showDeploy = !!onRetriggerBuild;

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm" data-testid="apps-unified-review-count">
        {isLoading && rows.length === 0
          ? 'Loading…'
          : `${rows.length}${hasMore ? '+' : ''} shown.`}
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
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Kind</Table.Th>
                <Table.Th>App</Table.Th>
                <Table.Th>Submitter</Table.Th>
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
                  actionLabel={actionLabel}
                  showDeploy={showDeploy}
                  onRetriggerBuild={onRetriggerBuild}
                  retriggeringId={retriggeringId ?? null}
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
function DeployStateChip({ state, rowKey }: { state: string | null; rowKey: string }) {
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
  return (
    <Badge size="sm" color={color} variant="light" data-testid={testId}>
      {state}
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

function UnifiedReviewRowView({
  row,
  actionLabel,
  showDeploy,
  onRetriggerBuild,
  retriggeringId,
}: {
  row: UnifiedReviewRow;
  actionLabel: string;
  showDeploy: boolean;
  onRetriggerBuild?: (publishRequestId: string) => void;
  retriggeringId: string | null;
}) {
  const submitter = row.submitter;
  const deploy = row.deploy;
  return (
    <Table.Tr style={{ cursor: 'pointer' }} data-testid={`apps-unified-review-row-${row.key}`}>
      <Table.Td onClick={row.onReview}>
        <Badge
          size="sm"
          variant="light"
          color={row.badgeColor}
          data-testid={`apps-unified-review-kind-${row.key}`}
        >
          {row.badge}
        </Badge>
      </Table.Td>
      <Table.Td onClick={row.onReview}>
        <Group gap={6} wrap="nowrap">
          {row.slug && <Code>{row.slug}</Code>}
        </Group>
        {row.title && row.title !== row.slug && (
          <Text size="xs" c="dimmed">
            {row.title}
          </Text>
        )}
      </Table.Td>
      <Table.Td onClick={row.onReview}>
        <Text size="xs">
          {submitter?.username ? submitter.username : `#${submitter?.id ?? '?'}`}
        </Text>
      </Table.Td>
      <Table.Td onClick={row.onReview}>
        <Group gap={4}>
          <IconClock size={14} />
          <Text size="xs">{row.submittedAt.toLocaleString()}</Text>
        </Group>
      </Table.Td>
      {showDeploy && (
        <Table.Td>
          {deploy ? (
            <Stack gap={4} align="flex-start">
              <DeployStateChip state={deploy.state} rowKey={row.key} />
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
