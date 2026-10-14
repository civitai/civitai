import {
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
import { useMemo, useState } from 'react';
import { ModQueryError, isModAuthzError } from '~/components/Apps/ModQuerySurface';
import { ReasonGatedActionModal } from '~/components/Apps/ReasonGatedActionModal';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { RouterOutput } from '~/types/router';

/**
 * `/apps/review` → "Storage reports": shared documents in the App Blocks document store that
 * viewers reported, across every app, with hide / unhide / delete (`apps.mod.docStore.*`).
 * Every action requires a reason, which is written to the app's moderation history.
 */

type Row = RouterOutput['apps']['mod']['docStore']['listReported']['items'][number];
type Status = 'open' | 'hidden' | 'all';
type Sort = 'reports' | 'newest';
type Action = 'hide' | 'unhide' | 'delete';

const DATE_FORMAT = 'MMM D, YYYY HH:mm';
const PAGE_LIMIT = 50;

const STATUS_OPTIONS = [
  { value: 'open', label: 'Visible to the app' },
  { value: 'hidden', label: 'Hidden' },
  { value: 'all', label: 'All' },
];
const SORT_OPTIONS = [
  { value: 'reports', label: 'Most reported' },
  { value: 'newest', label: 'Newest report' },
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
    body: 'The app will read it again, with its counts.',
    done: 'Document unhidden',
  },
  delete: {
    button: 'Delete',
    title: 'Delete this document permanently?',
    body: 'The document, its counts and its marks are removed. This cannot be undone.',
    done: 'Document deleted',
  },
};

const targetOf = (row: Row) => ({
  appBlockId: row.appBlockId,
  collection: row.collection,
  key: row.key,
});

function DocDataModal({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const doc = trpc.apps.mod.docStore.get.useQuery(row ? targetOf(row) : (undefined as never), {
    enabled: row != null,
    retry: false,
  });
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
      ) : doc.data ? (
        <ScrollArea.Autosize mah={480}>
          <Code block data-testid="doc-store-report-data">
            {JSON.stringify(doc.data.data, null, 2)}
          </Code>
        </ScrollArea.Autosize>
      ) : null}
    </Modal>
  );
}

function ReportRow({
  row,
  busy,
  onView,
  onAction,
}: {
  row: Row;
  busy: boolean;
  onView: () => void;
  onAction: (action: Action) => void;
}) {
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
          <Group gap="xs" wrap="nowrap">
            <Button size="xs" variant="default" onClick={onView}>
              View data
            </Button>
            <Button
              size="xs"
              variant="default"
              loading={busy}
              onClick={() => onAction(row.hidden ? 'unhide' : 'hide')}
            >
              {DOC_STORE_ACTION_COPY[row.hidden ? 'unhide' : 'hide'].button}
            </Button>
            <Button
              size="xs"
              color="red"
              variant="light"
              loading={busy}
              onClick={() => onAction('delete')}
            >
              {DOC_STORE_ACTION_COPY.delete.button}
            </Button>
          </Group>
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
          {row.lastReportedAt && (
            <Text size="xs" c="dimmed">
              Last reported {formatDate(row.lastReportedAt, DATE_FORMAT)}
            </Text>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

export function AppDocStoreReportsQueue() {
  const [status, setStatus] = useState<Status>('open');
  const [sort, setSort] = useState<Sort>('reports');
  const [viewing, setViewing] = useState<Row | null>(null);
  const [pending, setPending] = useState<{ row: Row; action: Action } | null>(null);
  const [reason, setReason] = useState('');

  const utils = trpc.useUtils();
  const list = trpc.apps.mod.docStore.listReported.useInfiniteQuery(
    { status, sort, limit: PAGE_LIMIT },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, retry: false }
  );
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const close = () => {
    setPending(null);
    setReason('');
  };
  const done = async (action: Action) => {
    showSuccessNotification({ message: DOC_STORE_ACTION_COPY[action].done });
    close();
    await utils.apps.mod.docStore.listReported.invalidate();
  };
  const failed = (error: { message: string }) => {
    showErrorNotification({
      title: 'Could not update the document',
      error: new Error(error.message),
    });
    close();
    void utils.apps.mod.docStore.listReported.invalidate();
  };
  const setHidden = trpc.apps.mod.docStore.setHidden.useMutation({
    onSuccess: (_data, vars) => done(vars.hidden ? 'hide' : 'unhide'),
    onError: failed,
  });
  const remove = trpc.apps.mod.docStore.delete.useMutation({
    onSuccess: () => done('delete'),
    onError: failed,
  });
  const submitting = setHidden.isPending || remove.isPending;

  const confirm = () => {
    if (!pending) return;
    // `version` ties the action to the version this row showed: a document edited since is
    // refused (CONFLICT) instead of acted on unseen.
    const input = { ...targetOf(pending.row), version: pending.row.version, reason: reason.trim() };
    if (pending.action === 'delete') remove.mutate(input);
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
        <Select
          label="Sort"
          data={SORT_OPTIONS}
          value={sort}
          allowDeselect={false}
          onChange={(v) => setSort((v as Sort) ?? 'reports')}
          w={180}
          data-testid="doc-store-reports-sort"
        />
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
      ) : !rows.length ? (
        <Text c="dimmed" py="lg" ta="center">
          No reported documents match these filters.
        </Text>
      ) : (
        <Stack gap="sm">
          {rows.map((row) => (
            <ReportRow
              key={`${row.appBlockId}/${row.collection}/${row.key}`}
              row={row}
              busy={submitting && pending?.row === row}
              onView={() => setViewing(row)}
              onAction={(action) => setPending({ row, action })}
            />
          ))}
          {list.hasNextPage && (
            <Center>
              <Button
                variant="default"
                onClick={() => list.fetchNextPage()}
                loading={list.isFetchingNextPage}
              >
                Load more
              </Button>
            </Center>
          )}
        </Stack>
      )}

      <DocDataModal row={viewing} onClose={() => setViewing(null)} />

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
