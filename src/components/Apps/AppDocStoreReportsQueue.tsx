import {
  Alert,
  Badge,
  Button,
  Center,
  Code,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { useState } from 'react';
import { ModQueryError, isModAuthzError } from '~/components/Apps/ModQuerySurface';
import { ReasonGatedActionModal } from '~/components/Apps/ReasonGatedActionModal';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { RouterOutput } from '~/types/router';

/**
 * `/apps/review` → "Storage reports": shared documents in the App Blocks document store with
 * open reports, across every app (`apps.mod.docStore.*`). A moderator opens a document to
 * review it, then hides / unhides it, dismisses its reports (reviewed and kept), or deletes it.
 * Every action requires a reason, written to the moderation audit log.
 *
 * Actions live in the review dialog, not on the row, and send the revision of the document
 * the dialog SHOWS: the store refuses them if the document changed since, so a moderator can
 * never act on content they have not seen. The list is capped rather than paged; when it was
 * cut off, or an app could not be read, it says so.
 */

type Row = RouterOutput['apps']['mod']['docStore']['listReported']['items'][number];
type Doc = RouterOutput['apps']['mod']['docStore']['get'];
type Status = 'open' | 'hidden' | 'all';
type Action = 'hide' | 'unhide' | 'dismiss' | 'delete';

const DATE_FORMAT = 'MMM D, YYYY HH:mm';

const STATUS_OPTIONS = [
  { value: 'open', label: 'Visible to the app' },
  { value: 'hidden', label: 'Hidden' },
  { value: 'all', label: 'All' },
];

export const DOC_STORE_ACTION_COPY: Record<
  Action,
  { button: string; title: string; body: string; done: string }
> = {
  hide: {
    button: 'Hide',
    title: 'Hide this document?',
    body: 'The app will read it as not found. Its data and counts are kept, and you can unhide it later.',
    done: 'Document hidden',
  },
  unhide: {
    button: 'Unhide',
    title: 'Unhide this document?',
    body: 'The app will read it again, with its counts. Dismissed reports stay dismissed.',
    done: 'Document unhidden',
  },
  dismiss: {
    button: 'Dismiss reports',
    title: 'Dismiss the reports on this document?',
    body: 'You reviewed it and it stays. Its open reports are closed and it leaves the queue until someone reports it again.',
    done: 'Reports dismissed',
  },
  delete: {
    button: 'Delete',
    title: 'Delete this document permanently?',
    body: 'The document, its counts and its marks are removed. This cannot be undone.',
    done: 'Document deleted',
  },
};

export const DOC_STORE_TRUNCATED_COPY =
  'Not every reported document is shown: the list is capped per app and in total. Dismiss the reports on documents you reviewed and kept (or hide or delete the rest) and refresh to see more.';

const targetOf = (row: Row) => ({
  appBlockId: row.appBlockId,
  collection: row.collection,
  key: row.key,
});

function ReviewModal({
  row,
  onClose,
  onAction,
}: {
  row: Row | null;
  onClose: () => void;
  /** `doc` is the document as displayed; its revision is what the action is bound to. */
  onAction: (doc: Doc, action: Action) => void;
}) {
  // Always fetched on open, never served from a cache the app otherwise keeps forever
  // (`staleTime: Infinity`), so what is shown is what was just read.
  const doc = trpc.apps.mod.docStore.get.useQuery(row ? targetOf(row) : (undefined as never), {
    enabled: row != null,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const shown = doc.data;
  return (
    <Modal
      opened={row != null}
      onClose={onClose}
      title={row ? `${row.appSlug} · ${row.collection}/${row.key}` : ''}
      size="lg"
    >
      {doc.isLoading ? (
        <Center py="md">
          <Loader size="sm" />
        </Center>
      ) : doc.error ? (
        <Text c="red" size="sm">
          Could not load the document: {doc.error.message}
        </Text>
      ) : shown ? (
        <Stack gap="sm">
          <Group gap="md" wrap="wrap">
            <Text size="xs" c="dimmed" data-testid="doc-store-review-revision">
              Revision {shown.revision}
            </Text>
            <Text size="xs" c="dimmed">
              {shown.reports} open report{shown.reports === 1 ? '' : 's'}
            </Text>
            {shown.reportsDismissedAt && (
              <Text size="xs" c="dimmed">
                Reports last dismissed {formatDate(shown.reportsDismissedAt, DATE_FORMAT)}
              </Text>
            )}
            {doc.isFetching && <Loader size="xs" />}
          </Group>
          <ScrollArea.Autosize mah={420}>
            <Code block data-testid="doc-store-report-data">
              {JSON.stringify(shown.data, null, 2)}
            </Code>
          </ScrollArea.Autosize>
          <Group justify="flex-end" gap="xs">
            <Button
              size="xs"
              variant="default"
              onClick={() => onAction(shown, shown.hidden ? 'unhide' : 'hide')}
            >
              {DOC_STORE_ACTION_COPY[shown.hidden ? 'unhide' : 'hide'].button}
            </Button>
            {/* Dismissing is for a document reviewed and KEPT visible; a hidden one is unhidden first. */}
            {!shown.hidden && (
              <Button size="xs" variant="default" onClick={() => onAction(shown, 'dismiss')}>
                {DOC_STORE_ACTION_COPY.dismiss.button}
              </Button>
            )}
            <Button size="xs" color="red" variant="light" onClick={() => onAction(shown, 'delete')}>
              {DOC_STORE_ACTION_COPY.delete.button}
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}

function ReportRow({ row, onReview }: { row: Row; onReview: () => void }) {
  const author =
    row.author.kind === 'user'
      ? `${row.author.username ?? 'unknown'} (#${row.author.userId})`
      : row.author.kind === 'counter'
      ? 'created by a counter'
      : 'the app';
  return (
    <Paper
      withBorder
      p="sm"
      data-testid="doc-store-report-row"
      data-key={`${row.appBlockId}/${row.collection}/${row.key}`}
      data-hidden={row.hidden ? 'true' : 'false'}
    >
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="xs">
            <Text fw={600} size="sm">
              {row.appSlug}
            </Text>
            <Text size="sm" ff="monospace">
              {row.collection}/{row.key}
            </Text>
            <Badge size="xs" color="red" variant="light">
              {row.reports} report{row.reports === 1 ? '' : 's'}
            </Badge>
            {row.hidden && (
              <Badge size="xs" color="orange" variant="light" data-testid="doc-store-report-hidden">
                Hidden{row.hidden.byUsername ? ` by ${row.hidden.byUsername}` : ''}
              </Badge>
            )}
          </Group>
          <Button size="xs" variant="default" onClick={onReview}>
            Review
          </Button>
        </Group>
        <Group gap="md" wrap="wrap">
          <Text size="xs" c="dimmed">
            Author: {author}
          </Text>
          <Text size="xs" c="dimmed">
            Created {formatDate(row.createdAt, DATE_FORMAT)}
          </Text>
          <Text size="xs" c="dimmed">
            Updated {formatDate(row.updatedAt, DATE_FORMAT)}
          </Text>
        </Group>
      </Stack>
    </Paper>
  );
}

export function AppDocStoreReportsQueue() {
  const [status, setStatus] = useState<Status>('open');
  const [reviewing, setReviewing] = useState<Row | null>(null);
  const [pending, setPending] = useState<{ row: Row; doc: Doc; action: Action } | null>(null);
  const [reason, setReason] = useState('');

  const utils = trpc.useUtils();
  const list = trpc.apps.mod.docStore.listReported.useQuery({ status }, { retry: false });
  const rows = list.data?.items ?? [];

  const close = () => {
    setPending(null);
    setReason('');
  };
  const refresh = () =>
    Promise.all([
      utils.apps.mod.docStore.listReported.invalidate(),
      utils.apps.mod.docStore.get.invalidate(),
    ]);
  const done = async (action: Action) => {
    showSuccessNotification({ message: DOC_STORE_ACTION_COPY[action].done });
    close();
    setReviewing(null);
    await refresh();
  };
  const failed = (error: { message: string }) => {
    showErrorNotification({
      title: 'Could not update the document',
      error: new Error(error.message),
    });
    close();
    void refresh();
  };
  const setHidden = trpc.apps.mod.docStore.setHidden.useMutation({
    onSuccess: (_data, vars) => done(vars.hidden ? 'hide' : 'unhide'),
    onError: failed,
  });
  const dismiss = trpc.apps.mod.docStore.dismissReports.useMutation({
    onSuccess: () => done('dismiss'),
    onError: failed,
  });
  const remove = trpc.apps.mod.docStore.delete.useMutation({
    onSuccess: () => done('delete'),
    onError: failed,
  });
  const submitting = setHidden.isPending || dismiss.isPending || remove.isPending;

  const confirm = () => {
    if (!pending) return;
    // The revision of the document the dialog DISPLAYED, not the list row's: a document that
    // changed since is refused (CONFLICT) instead of acted on unseen.
    const input = {
      ...targetOf(pending.row),
      revision: pending.doc.revision,
      reason: reason.trim(),
    };
    if (pending.action === 'delete') remove.mutate(input);
    else if (pending.action === 'dismiss') dismiss.mutate(input);
    else setHidden.mutate({ ...input, hidden: pending.action === 'hide' });
  };

  if (list.error && isModAuthzError(list.error)) return null;

  return (
    <Stack gap="md" data-testid="doc-store-reports-queue">
      <Group align="flex-end" gap="md" wrap="wrap">
        <Select
          label="Status"
          data={STATUS_OPTIONS}
          value={status}
          allowDeselect={false}
          onChange={(v) => setStatus((v as Status) ?? 'open')}
          w={200}
          data-testid="doc-store-reports-status"
        />
        <Button
          variant="default"
          onClick={() => list.refetch()}
          loading={list.isFetching}
          data-testid="doc-store-reports-refresh"
        >
          Refresh
        </Button>
      </Group>

      {list.isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : list.error ? (
        <ModQueryError
          error={list.error}
          onRetry={() => list.refetch()}
          isRetrying={list.isFetching}
          title="Couldn’t load storage reports"
        />
      ) : null}

      {list.data && list.data.failedApps > 0 && (
        <Alert color="red" variant="light" data-testid="doc-store-reports-failed-apps">
          {list.data.failedApps} app{list.data.failedApps === 1 ? '' : 's'} could not be read, so
          their reports are missing from this list. Refresh to try again.
        </Alert>
      )}
      {list.data?.truncated && (
        <Alert color="yellow" variant="light" data-testid="doc-store-reports-truncated">
          {DOC_STORE_TRUNCATED_COPY}
        </Alert>
      )}

      {list.isLoading || list.error ? null : !rows.length ? (
        <Text c="dimmed" py="lg" ta="center">
          No reported documents match these filters.
        </Text>
      ) : (
        <Stack gap="sm">
          {rows.map((row) => (
            <ReportRow
              key={`${row.appBlockId}/${row.collection}/${row.key}`}
              row={row}
              onReview={() => setReviewing(row)}
            />
          ))}
        </Stack>
      )}

      <ReviewModal
        row={reviewing}
        onClose={() => setReviewing(null)}
        onAction={(doc, action) => reviewing && setPending({ row: reviewing, doc, action })}
      />

      <ReasonGatedActionModal
        opened={pending != null}
        onCancel={close}
        title={pending ? DOC_STORE_ACTION_COPY[pending.action].title : ''}
        busy={submitting}
        reason={reason}
        onReasonChange={setReason}
        reasonPlaceholder="Why this action — recorded in the moderation audit log."
        reasonTestId="doc-store-report-reason"
        destructive={pending?.action === 'delete'}
        destructiveWarning={<Text size="sm">{DOC_STORE_ACTION_COPY.delete.body}</Text>}
        extraSlot={
          pending && pending.action !== 'delete' ? (
            <Text size="sm">{DOC_STORE_ACTION_COPY[pending.action].body}</Text>
          ) : undefined
        }
        submitLabel={pending ? DOC_STORE_ACTION_COPY[pending.action].button : ''}
        submitTestId="doc-store-report-confirm"
        onSubmit={confirm}
      />
    </Stack>
  );
}
