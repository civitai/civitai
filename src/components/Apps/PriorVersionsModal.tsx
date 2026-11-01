import { Alert, Badge, Code, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import {
  ListingHistoryEntryRow,
  type ListingHistoryEntry,
} from '~/components/Apps/ListingHistoryPanel';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import type { ReviewSubmitterChip } from '~/components/Apps/unifiedReviewRow';
import { trpc } from '~/utils/trpc';

/**
 * MODERATOR view of every submission an app has ever made — opened from the Version cell
 * of the `/apps/review` queue. Backed by `blocks.listVersionHistory` — see
 * `~/server/services/blocks/publish-request.service` for why it is slug-keyed and why it
 * is a mod proc rather than a widening of the author-facing listing history.
 */

export type PriorVersionsSelection = {
  slug: string;
  /** The entry the moderator is looking at, marked in the list. Null when the row has no
   *  code request of its own. */
  currentRequestId: string | null;
  /** The app's display name. Rendered beside the slug in the modal title, and only when
   *  it differs from it — an app whose manifest name IS its slug would otherwise read
   *  twice. */
  title: string;
} | null;

/**
 * One row of `blocks.listVersionHistory`.
 *
 * 🔴 BOTH USER CHIPS CARRY `deletedAt`, AND BOTH NEED IT. This modal renders `submittedBy`
 * and `reviewedBy` through the same `UserAvatar`, which branches on `deletedAt` in two
 * places: `UserProfileLink` suppresses `linkToProfile` for a deleted account, and `Username`
 * renders "[deleted]" instead of a name. Omit the field and the value is `undefined` ⇒ falsy
 * ⇒ a deleted submitter OR a deleted moderator renders as a live, linked account.
 */
export type VersionHistoryEntry = {
  id: string;
  version: string;
  status: string;
  submittedAt: string | Date;
  reviewedAt: string | Date | null;
  submittedBy: ReviewSubmitterChip;
  reviewedBy: ReviewSubmitterChip;
  rejectionReason: string | null;
  deployState: string | null;
};

/**
 * Project a version-history entry onto the shared history-row shape.
 *
 * `approvalNotes`/`changelog` are null because this read does not carry them, and
 * `canWithdraw` is omitted so the shared row renders no Withdraw button — both withdraw
 * procs are submitter-scoped, so offering one to a moderator is a guaranteed red toast.
 */
export function toHistoryEntry(entry: VersionHistoryEntry): ListingHistoryEntry {
  return {
    id: entry.id,
    source: 'version',
    status: entry.status,
    version: entry.version,
    submittedAt: entry.submittedAt,
    reviewedAt: entry.reviewedAt,
    rejectionReason: entry.rejectionReason,
    approvalNotes: null,
    changelog: null,
    deployState: entry.deployState,
  };
}

export function PriorVersionsBody({
  selection,
  entries,
  loading = false,
  errorMessage = null,
  truncated = false,
}: {
  selection: PriorVersionsSelection;
  entries: VersionHistoryEntry[];
  loading?: boolean;
  errorMessage?: string | null;
  /** The read is bounded; say so rather than presenting a clipped list as complete. */
  truncated?: boolean;
}) {
  return (
    <>
      {errorMessage ? (
        <Alert color="red" variant="light" data-testid="apps-prior-versions-error">
          {errorMessage}
        </Alert>
      ) : loading ? (
        <Group gap="xs" data-testid="apps-prior-versions-loading">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Loading version history…
          </Text>
        </Group>
      ) : entries.length === 0 ? (
        <Text size="sm" c="dimmed" data-testid="apps-prior-versions-empty">
          No submissions recorded for this app.
        </Text>
      ) : (
        <Stack gap={8} data-testid="apps-prior-versions-list">
          {entries.map((e) => (
            <ListingHistoryEntryRow key={e.id} entry={toHistoryEntry(e)}>
              {e.id === selection?.currentRequestId && (
                <Badge
                  size="sm"
                  color="violet"
                  variant="filled"
                  data-testid={`apps-prior-versions-current-${e.id}`}
                >
                  current
                </Badge>
              )}
              {e.submittedBy && (
                <Group gap={4} wrap="nowrap">
                  <Text size="xs" c="dimmed">
                    by
                  </Text>
                  <UserAvatar user={e.submittedBy} size="xs" withUsername />
                </Group>
              )}
              {e.reviewedBy && (
                <Group gap={4} wrap="nowrap">
                  <Text size="xs" c="dimmed">
                    reviewed by
                  </Text>
                  <UserAvatar user={e.reviewedBy} size="xs" withUsername />
                </Group>
              )}
            </ListingHistoryEntryRow>
          ))}
          {truncated && (
            <Text size="xs" c="dimmed" data-testid="apps-prior-versions-truncated">
              Showing the most recent submissions only.
            </Text>
          )}
        </Stack>
      )}
    </>
  );
}

/**
 * The modal shell + the mod-only history read.
 *
 * The `<Modal>` lives HERE rather than in the body for the same reason
 * `OnsiteReviewModal` splits that way: the page mounts this as a portaled sibling of the
 * shared chrome, and `appsPageWidths.test.ts` verifies that an allowlisted sibling really
 * does render a Mantine portal root at its top level rather than page content.
 *
 * The query is `enabled` only while a selection exists, so a closed modal fetches nothing.
 */
export function PriorVersionsModal({
  selection,
  onClose,
}: {
  selection: PriorVersionsSelection;
  onClose: () => void;
}) {
  const query = trpc.blocks.listVersionHistory.useQuery(
    { slug: selection?.slug ?? '' },
    { enabled: !!selection?.slug, retry: false }
  );
  return (
    <Modal
      opened={!!selection}
      onClose={onClose}
      size="lg"
      centered
      // Mantine's default close button has no accessible name, so a screen-reader user gets
      // an unlabelled control on a page that already has several dialogs.
      closeButtonProps={{ 'aria-label': 'Close version history' }}
      title={
        selection ? (
          <Group gap={6}>
            <Text fw={600}>Prior versions</Text>
            <Code>{selection.slug}</Code>
            {selection.title && selection.title !== selection.slug && (
              <Text size="sm" c="dimmed" data-testid="apps-prior-versions-title">
                {selection.title}
              </Text>
            )}
          </Group>
        ) : null
      }
    >
      <PriorVersionsBody
        selection={selection}
        entries={(query.data?.items ?? []) as VersionHistoryEntry[]}
        loading={query.isLoading && !!selection}
        errorMessage={query.error?.message ?? null}
        truncated={!!query.data?.truncated}
      />
    </Modal>
  );
}
