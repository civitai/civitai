import {
  Alert,
  Anchor,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core';
import { IconAlertTriangle, IconFlag, IconLock } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import type { InboxActionError, InboxStatusFilter } from '~/components/Apps/appFeedbackInbox';
import {
  buildSetOwnerStatusInput,
  feedbackRowMeta,
  INBOX_STATUS_FILTERS,
  inboxActionError,
  inboxEmptyMessages,
  INBOX_PRIVACY_NOTE,
  inboxStatusFilterInput,
  OWNER_STATUS_LABELS,
  ownerStatusChoices,
  ownerStatusColor,
  ownerStatusLabel,
  reporterLabel,
} from '~/components/Apps/appFeedbackInbox';
import type { OwnerFeedbackDto } from '~/server/services/blocks/app-feedback.service';
import type { ListingKind } from '~/shared/constants/app-capabilities.constants';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

export function AppFeedbackInboxPanel({
  appListingId,
  kind,
}: {
  appListingId: string;
  kind: ListingKind;
}) {
  const [filter, setFilter] = useState<InboxStatusFilter>('all');
  const query = trpc.appFeedback.listForListing.useInfiniteQuery(
    { appListingId, ownerStatus: inboxStatusFilterInput(filter) },
    { getNextPageParam: (lastPage) => lastPage.nextCursor, retry: false }
  );
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  return (
    <Stack gap="md" data-testid="app-feedback-inbox">
      <Alert color="gray" variant="light" icon={<IconLock size={16} />}>
        <Text size="sm" data-testid="app-feedback-privacy">
          {INBOX_PRIVACY_NOTE}
        </Text>
      </Alert>

      <SegmentedControl
        value={filter}
        onChange={(value) => setFilter(value as InboxStatusFilter)}
        data={INBOX_STATUS_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
        size="xs"
        w="fit-content"
        data-testid="app-feedback-filter"
      />

      {query.isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : query.error ? (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          data-testid="app-feedback-load-error"
        >
          {inboxActionError(query.error).message}
        </Alert>
      ) : items.length === 0 ? (
        <Stack gap={4} data-testid="app-feedback-empty">
          {inboxEmptyMessages(kind, filter).map((line) => (
            <Text key={line} size="sm" c="dimmed">
              {line}
            </Text>
          ))}
        </Stack>
      ) : (
        <Stack gap="sm">
          {items.map((item) => (
            <FeedbackRow
              key={item.id}
              appListingId={appListingId}
              item={item}
              onRefresh={() => void query.refetch()}
            />
          ))}
          {query.hasNextPage && (
            <Group justify="center">
              <Button
                variant="default"
                onClick={() => void query.fetchNextPage()}
                loading={query.isFetchingNextPage}
                data-testid="app-feedback-load-more"
              >
                Load more
              </Button>
            </Group>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function FeedbackRow({
  appListingId,
  item,
  onRefresh,
}: {
  appListingId: string;
  item: OwnerFeedbackDto;
  onRefresh: () => void;
}) {
  const utils = trpc.useUtils();
  const [actionError, setActionError] = useState<InboxActionError | null>(null);
  const [confirmingFlag, setConfirmingFlag] = useState(false);

  // Returned to the mutation so it stays pending until the list (and badge count) refetch:
  // re-enabling the buttons over the stale row would send the old `expectedOwnerStatus` and
  // CONFLICT on the owner's own change.
  const refreshAfterWrite = () => {
    setActionError(null);
    return Promise.all([
      utils.appFeedback.listForListing.invalidate({ appListingId }),
      utils.appFeedback.countNewForMyListings.invalidate(),
    ]);
  };
  const setStatus = trpc.appFeedback.setOwnerStatus.useMutation({
    onSuccess: refreshAfterWrite,
    onError: (e) => setActionError(inboxActionError(e)),
  });
  const flag = trpc.appFeedback.flagAbusive.useMutation({
    onSuccess: async () => {
      await refreshAfterWrite();
      setConfirmingFlag(false);
    },
    onError: (e) => {
      setConfirmingFlag(false);
      setActionError(inboxActionError(e));
    },
  });
  const busy = setStatus.isPending || flag.isPending;
  const meta = feedbackRowMeta(item);
  const testId = (part: string) => `app-feedback-${part}-${item.id}`;

  return (
    <Paper withBorder p="sm" radius="md" data-testid={testId('row')}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Group gap="xs" wrap="wrap">
            {item.reporter.username ? (
              <Anchor
                href={`/user/${encodeURIComponent(item.reporter.username)}`}
                size="sm"
                fw={600}
                data-testid={testId('reporter')}
              >
                {item.reporter.username}
              </Anchor>
            ) : (
              <Text size="sm" fw={600} c="dimmed" data-testid={testId('reporter')}>
                {reporterLabel(null)}
              </Text>
            )}
            <Text size="xs" c="dimmed" data-testid={testId('meta')}>
              {[...meta, formatDate(item.createdAt, 'MMM D, YYYY')].join(' · ')}
            </Text>
          </Group>
          <Group gap={6}>
            {item.ownerFlaggedAt && (
              <Badge color="red" variant="light" data-testid={testId('flagged')}>
                Flagged for moderators
              </Badge>
            )}
            <Badge
              color={ownerStatusColor(item.ownerStatus)}
              variant="light"
              data-testid={testId('status')}
            >
              {ownerStatusLabel(item.ownerStatus)}
            </Badge>
          </Group>
        </Group>

        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }} data-testid={testId('message')}>
          {item.message}
        </Text>

        {actionError && (
          <Alert color="red" variant="light" p="xs" data-testid={testId('error')}>
            <Group justify="space-between" gap="xs">
              <Text size="sm">{actionError.message}</Text>
              {actionError.kind === 'stale' && (
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={() => {
                    setActionError(null);
                    onRefresh();
                  }}
                  data-testid={testId('refresh')}
                >
                  Refresh
                </Button>
              )}
            </Group>
          </Alert>
        )}

        {confirmingFlag ? (
          <Alert color="red" variant="light" p="xs" data-testid={testId('flag-confirm')}>
            <Stack gap="xs">
              <Text size="sm">
                Flag this as abusive? Civitai moderators will review it. You can&apos;t undo this.
              </Text>
              <Group gap="xs">
                <Button
                  size="compact-xs"
                  color="red"
                  loading={flag.isPending}
                  onClick={() => flag.mutate({ id: item.id, appListingId })}
                  data-testid={testId('flag-confirm-yes')}
                >
                  Flag as abusive
                </Button>
                <Button
                  size="compact-xs"
                  variant="default"
                  disabled={flag.isPending}
                  onClick={() => setConfirmingFlag(false)}
                  data-testid={testId('flag-confirm-no')}
                >
                  Cancel
                </Button>
              </Group>
            </Stack>
          </Alert>
        ) : (
          <Group justify="space-between" gap="xs" wrap="wrap">
            <Group gap={6} wrap="wrap">
              <Text size="xs" c="dimmed">
                Mark as
              </Text>
              {ownerStatusChoices(item.ownerStatus).map((next) => (
                <Button
                  key={next}
                  size="compact-xs"
                  variant="light"
                  color={ownerStatusColor(next)}
                  disabled={busy}
                  loading={setStatus.isPending && setStatus.variables?.ownerStatus === next}
                  onClick={() =>
                    setStatus.mutate(buildSetOwnerStatusInput(appListingId, item, next))
                  }
                  data-testid={testId(`set-${next}`)}
                >
                  {OWNER_STATUS_LABELS[next]}
                </Button>
              ))}
            </Group>
            {!item.ownerFlaggedAt && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                leftSection={<IconFlag size={12} />}
                disabled={busy}
                onClick={() => {
                  setActionError(null);
                  setConfirmingFlag(true);
                }}
                data-testid={testId('flag')}
              >
                Flag as abusive
              </Button>
            )}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
