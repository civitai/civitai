import { Alert, Badge, Button, Card, Code, Group, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconClock, IconExternalLink } from '@tabler/icons-react';
import { useMemo } from 'react';
import type { OffsitePendingRow } from '~/components/Apps/OffsiteReviewQueue';
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
}) {
  const rows = useMemo(() => {
    const onsiteRows = onsiteItems.map((r) => onsiteRequestToUnifiedRow(r, openOnsiteReview));
    const offsiteRows = offsiteItems.map((r) => offsiteRequestToUnifiedRow(r, openOffsiteReview));
    return mergeReviewRows(onsiteRows, offsiteRows, direction, openCombinedReview);
  }, [onsiteItems, offsiteItems, direction, openOnsiteReview, openOffsiteReview, openCombinedReview]);

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
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <UnifiedReviewRowView key={row.key} row={row} actionLabel={actionLabel} />
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

function UnifiedReviewRowView({ row, actionLabel }: { row: UnifiedReviewRow; actionLabel: string }) {
  const submitter = row.submitter;
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
