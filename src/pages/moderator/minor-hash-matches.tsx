import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Container,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconExternalLink } from '@tabler/icons-react';
import type { MRT_ColumnDef } from 'mantine-react-table';
import { MantineReactTable } from 'mantine-react-table';
import { useMemo, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink } from '~/components/NextLink/NextLink';
import type { MinorHashReviewRow } from '~/server/services/minor-hash.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({ requireModerator: true });

// The full queue is fetched in one request; this is a safety cap, not a page size.
const limit = 1000;

// Deep-links to the version whose file actually carries the matching hash — a
// model's default version is often not the one that matched.
const modelHref = (modelId: number, versionId?: number | null) =>
  `/models/${modelId}?view=basic${versionId ? `&modelVersionId=${versionId}` : ''}`;

// Published is the one that still needs a decision — the copy is live and
// downloadable right now — so it reads as active rather than resolved.
const statusColors: Record<string, string> = {
  Published: 'blue',
  Scheduled: 'cyan',
  Draft: 'gray',
  Unpublished: 'gray',
  UnpublishedViolation: 'yellow',
  Deleted: 'red',
};

function DetailPanel({ row }: { row: MinorHashReviewRow }) {
  const { data, isLoading } = trpc.moderator.models.queryMinorHashMatchDetail.useQuery({
    modelId: row.modelId,
    minorModelId: row.minorModelId,
  });

  if (isLoading) return <Loader size="sm" />;

  return (
    <div className="flex flex-wrap gap-6 p-2">
      <div className="flex gap-3">
        {data?.modelCoverUrl && (
          <EdgeMedia
            src={data.modelCoverUrl}
            type={(data.modelCoverType ?? 'image') as MediaType}
            width={140}
          />
        )}
        <Stack gap={2}>
          <Text fw={600}>{row.modelName}</Text>
          <Text size="xs" c="dimmed">
            Uploaded {row.createdAt ? formatDate(row.createdAt) : 'unknown'} · {row.status}
          </Text>
          <Text size="xs" c="dimmed">
            {row.username ?? row.userId} · {data?.uploaderModelCount ?? 0} models · joined{' '}
            {data?.uploaderJoinedAt ? formatDate(data.uploaderJoinedAt) : 'unknown'}
          </Text>
          <Anchor
            component={NextLink}
            href={modelHref(row.modelId, row.modelVersionId)}
            target="_blank"
            size="xs"
          >
            <Group gap={4}>
              Open model <IconExternalLink size={12} />
            </Group>
          </Anchor>
        </Stack>
      </div>

      <div className="flex gap-3">
        {data?.minorModelCoverUrl && (
          <EdgeMedia
            src={data.minorModelCoverUrl}
            type={(data.minorModelCoverType ?? 'image') as MediaType}
            width={140}
          />
        )}
        <Stack gap={2}>
          <Text fw={600}>Matches: {row.minorModelName ?? `#${row.minorModelId}`}</Text>
          <Text size="xs" c="dimmed">
            {data?.minorUsername ?? row.minorUserId} · {data?.minorModelStatus ?? 'unknown'}
          </Text>
          {/* Only 2 of ~13.5k minor-locked models have a setMinor ModActivity row, so
              rendering a placeholder here would read as missing data on every row. */}
          {data?.minorFlaggedAt && (
            <Text size="xs" c="dimmed">
              Set minor {formatDate(data.minorFlaggedAt)}
              {data.minorFlaggedByUsername ? ` by ${data.minorFlaggedByUsername}` : ''}
            </Text>
          )}
          <Anchor
            component={NextLink}
            href={modelHref(row.minorModelId, row.minorModelVersionId)}
            target="_blank"
            size="xs"
          >
            <Group gap={4}>
              Open flagged model <IconExternalLink size={12} />
            </Group>
          </Anchor>
        </Stack>
      </div>

      <Stack gap={2}>
        <Text size="xs" fw={600}>
          Shared SHA256
        </Text>
        <Code>{row.hash}</Code>
      </Stack>
    </div>
  );
}

type AutoFlaggedRow = {
  modelId: number;
  modelName: string;
  userId: number;
  username: string | null;
  status: string;
  flaggedAt: Date;
  prevNsfw: boolean | null;
  prevGalleryLevel: number | null;
};

// Models the scan hook flagged with no human in the loop. Confirming records the
// moderator's own setMinor, which both clears the row from here and stops a bulk
// rollback from undoing it.
function AutoFlaggedTable() {
  const queryUtils = trpc.useUtils();
  const { data, isLoading, isFetching } =
    trpc.moderator.models.queryAutoFlaggedMinorModels.useQuery({ limit });
  const items = useMemo(() => data?.items ?? [], [data]);

  const onSettled = async () => {
    await queryUtils.moderator.models.queryAutoFlaggedMinorModels.invalidate();
    await queryUtils.moderator.models.queryMinorHashMatches.invalidate();
  };
  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Action failed', error });

  const confirmMutation = trpc.moderator.models.confirmMinorHashAutoFlag.useMutation({
    onSuccess: onSettled,
    onError,
  });
  const revertMutation = trpc.moderator.models.revertMinorHashAutoFlag.useMutation({
    onSuccess: onSettled,
    onError,
  });

  const columns = useMemo<MRT_ColumnDef<AutoFlaggedRow>[]>(
    () => [
      {
        id: 'modelName',
        header: 'Model',
        accessorKey: 'modelName',
        size: 300,
        Cell: ({ row: { original } }) => (
          <Anchor
            component={NextLink}
            href={modelHref(original.modelId)}
            target="_blank"
            lineClamp={2}
          >
            {original.modelName}
          </Anchor>
        ),
      },
      {
        id: 'username',
        header: 'Uploader',
        accessorKey: 'username',
        size: 150,
        Cell: ({ row: { original } }) =>
          original.username ? (
            <Anchor
              component={NextLink}
              href={`/user/${original.username}`}
              target="_blank"
              lineClamp={1}
            >
              {original.username}
            </Anchor>
          ) : (
            <Text>{original.userId}</Text>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        size: 170,
        filterVariant: 'multi-select',
        Cell: ({ row: { original } }) => (
          <Badge
            size="sm"
            tt="none"
            color={statusColors[original.status] ?? 'gray'}
            variant="light"
          >
            {original.status}
          </Badge>
        ),
      },
      {
        id: 'flaggedAt',
        header: 'Auto-flagged',
        accessorFn: (row) => new Date(row.flaggedAt),
        sortingFn: 'datetime',
        size: 140,
        enableColumnFilter: false,
        Cell: ({ row: { original } }) => (
          <Text size="xs">{original.flaggedAt ? formatDate(original.flaggedAt) : '—'}</Text>
        ),
      },
      {
        id: 'actions',
        header: '',
        size: 200,
        enableSorting: false,
        enableColumnFilter: false,
        enableColumnActions: false,
        Cell: ({ row: { original } }) => (
          <Group gap="xs" justify="flex-end" wrap="nowrap">
            <Button
              size="compact-sm"
              loading={
                confirmMutation.isPending && confirmMutation.variables?.id === original.modelId
              }
              onClick={() => confirmMutation.mutate({ id: original.modelId })}
            >
              Keep flagged
            </Button>
            <Button
              size="compact-sm"
              variant="light"
              color="red"
              loading={
                revertMutation.isPending && revertMutation.variables?.id === original.modelId
              }
              onClick={() =>
                openConfirmModal({
                  title: 'Revert automatic minor flag',
                  centered: true,
                  labels: { confirm: 'Revert', cancel: 'Cancel' },
                  confirmProps: { color: 'red' },
                  children: (
                    <Text size="sm">
                      Unflag <strong>{original.modelName}</strong> and restore the settings it had
                      before the scan flagged it
                      {original.prevNsfw ? ', including its NSFW flag' : ''}
                      {original.prevGalleryLevel != null
                        ? ` and gallery level ${original.prevGalleryLevel}`
                        : ''}
                      .
                    </Text>
                  ),
                  onConfirm: () => revertMutation.mutate({ id: original.modelId }),
                })
              }
            >
              Revert
            </Button>
          </Group>
        ),
      },
    ],
    [confirmMutation, revertMutation]
  );

  return (
    <>
      {data?.truncated && (
        <Alert color="yellow" title="List truncated">
          Showing the first {limit} auto-flagged models.
        </Alert>
      )}
      <MantineReactTable
        columns={columns}
        data={items}
        enableStickyHeader
        enableColumnPinning
        enableSorting
        enableColumnFilters
        enableGlobalFilter
        enableFacetedValues
        layoutMode="grid"
        renderEmptyRowsFallback={() => (
          <Text p="xl" ta="center" c="dimmed">
            Nothing auto-flagged awaiting review.
          </Text>
        )}
        mantineTableContainerProps={{ style: { maxHeight: 600 } }}
        initialState={{
          density: 'xs',
          columnPinning: { right: ['actions'] },
          pagination: { pageIndex: 0, pageSize: 25 },
          showGlobalFilter: true,
          showColumnFilters: true,
        }}
        state={{ isLoading, showProgressBars: isFetching }}
      />
    </>
  );
}

export default function MinorHashMatches() {
  const queryUtils = trpc.useUtils();
  const [tab, setTab] = useState<string>('pending');
  const { data: autoData } = trpc.moderator.models.queryAutoFlaggedMinorModels.useQuery({ limit });
  const autoCount = autoData?.items.length ?? 0;

  const { data, isFetching, isLoading } = trpc.moderator.models.queryMinorHashMatches.useQuery({
    limit,
  });

  const items = useMemo(() => data?.items ?? [], [data]);

  const onSettled = async () => {
    await queryUtils.moderator.models.queryMinorHashMatches.invalidate();
  };
  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Action failed', error });

  const setMinorMutation = trpc.model.setMinor.useMutation({ onSuccess: onSettled, onError });
  const dismissMutation = trpc.moderator.models.dismissMinorHashMatch.useMutation({
    onSuccess: onSettled,
    onError,
  });

  const columns = useMemo<MRT_ColumnDef<MinorHashReviewRow>[]>(
    () => [
      {
        id: 'modelName',
        header: 'Model',
        accessorKey: 'modelName',
        size: 235,
        Cell: ({ row: { original } }) => (
          <Anchor
            component={NextLink}
            href={modelHref(original.modelId, original.modelVersionId)}
            target="_blank"
            lineClamp={2}
          >
            {original.modelName}
          </Anchor>
        ),
      },
      {
        id: 'username',
        header: 'Uploader',
        accessorKey: 'username',
        size: 130,
        Cell: ({ row: { original } }) =>
          original.username ? (
            <Anchor
              component={NextLink}
              href={`/user/${original.username}`}
              target="_blank"
              lineClamp={1}
            >
              {original.username}
            </Anchor>
          ) : (
            <Text>{original.userId}</Text>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        // Wide enough for "UnpublishedViolation" — truncating it loses the
        // distinction from a plain "Unpublished", which changes the mod's call.
        size: 170,
        filterVariant: 'multi-select',
        Cell: ({ row: { original } }) => (
          <Badge
            size="sm"
            tt="none"
            color={statusColors[original.status] ?? 'gray'}
            variant="light"
          >
            {original.status}
          </Badge>
        ),
      },
      {
        id: 'createdAt',
        header: 'Uploaded',
        accessorFn: (row) => new Date(row.createdAt),
        sortingFn: 'datetime',
        size: 125,
        enableColumnFilter: false,
        Cell: ({ row: { original } }) => (
          <Text size="xs">{original.createdAt ? formatDate(original.createdAt) : '—'}</Text>
        ),
      },
      {
        id: 'minorModelName',
        header: 'Matches flagged model',
        accessorKey: 'minorModelName',
        size: 215,
        Cell: ({ row: { original } }) => (
          <Anchor
            component={NextLink}
            href={modelHref(original.minorModelId, original.minorModelVersionId)}
            target="_blank"
            lineClamp={2}
          >
            {original.minorModelName ?? `#${original.minorModelId}`}
          </Anchor>
        ),
      },
      {
        // Actions stay pinned right so they're reachable without horizontal scroll.
        id: 'actions',
        header: '',
        size: 195,
        enableSorting: false,
        enableColumnFilter: false,
        enableColumnActions: false,
        Cell: ({ row: { original } }) => (
          <Group gap="xs" justify="flex-end" wrap="nowrap">
            <Button
              size="compact-sm"
              color="red"
              loading={
                setMinorMutation.isPending && setMinorMutation.variables?.id === original.modelId
              }
              onClick={() =>
                openConfirmModal({
                  title: 'Set model as minor',
                  centered: true,
                  labels: { confirm: 'Set as Minor', cancel: 'Cancel' },
                  confirmProps: { color: 'red' },
                  children: (
                    <Stack gap="xs">
                      <Text size="sm">
                        Flag <strong>{original.modelName}</strong> as minor? This forces the model
                        SFW-only, resets its gallery browsing level, and locks those properties.
                      </Text>
                      <Text size="sm" c="dimmed">
                        The current settings are saved first, so this can be undone — but only by a
                        rollback naming this model specifically. A blanket rollback deliberately
                        skips manual flags so it can&apos;t revert a moderator&apos;s decision.
                      </Text>
                    </Stack>
                  ),
                  onConfirm: () => setMinorMutation.mutate({ id: original.modelId, minor: true }),
                })
              }
            >
              Set as Minor
            </Button>
            <Button
              size="compact-sm"
              variant="light"
              loading={
                dismissMutation.isPending && dismissMutation.variables?.id === original.modelId
              }
              onClick={() => dismissMutation.mutate({ id: original.modelId })}
            >
              Dismiss
            </Button>
          </Group>
        ),
      },
    ],
    [setMinorMutation, dismissMutation]
  );

  return (
    <Container size="xl">
      <Stack gap="md">
        <div>
          <Title order={1}>Minor hash matches</Title>
          <Text c="dimmed" size="sm">
            Models sharing a byte-identical weight file with a model a moderator already flagged
            minor. Different-uploader matches wait for review here; same-uploader matches are
            flagged automatically at scan time and are listed under Auto-flagged.
          </Text>
        </div>

        <Tabs value={tab} onChange={(value) => setTab(value ?? 'pending')}>
          <Tabs.List>
            <Tabs.Tab value="pending">Pending review</Tabs.Tab>
            <Tabs.Tab value="auto">Auto-flagged{autoCount ? ` (${autoCount})` : ''}</Tabs.Tab>
          </Tabs.List>
        </Tabs>

        {tab === 'auto' && <AutoFlaggedTable />}

        {tab === 'pending' && (
          <>
            {data?.truncated && (
              <Alert color="yellow" title="Queue truncated">
                Showing the first {limit} matches. Work the queue down to see the rest.
              </Alert>
            )}

            <MantineReactTable
              columns={columns}
              data={items}
              enableStickyHeader
              enableColumnPinning
              // The whole queue is loaded, so client-side sorting, filtering and paging
              // act on every row rather than on a partial window.
              enableSorting
              enableColumnFilters
              enableGlobalFilter
              enableFacetedValues
              layoutMode="grid"
              renderDetailPanel={({ row }) => <DetailPanel row={row.original} />}
              renderEmptyRowsFallback={() => (
                <Text p="xl" ta="center" c="dimmed">
                  No matches pending review.
                </Text>
              )}
              mantineTableContainerProps={{ style: { maxHeight: 600 } }}
              initialState={{
                density: 'xs',
                columnPinning: { right: ['actions'] },
                pagination: { pageIndex: 0, pageSize: 25 },
                showGlobalFilter: true,
                showColumnFilters: true,
              }}
              state={{ isLoading, showProgressBars: isFetching }}
            />
          </>
        )}
      </Stack>
    </Container>
  );
}
