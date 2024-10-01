import { ActionIcon, Anchor, Badge, Button, JsonInput, Modal, Text } from '@mantine/core';
import { IconAlertCircle, IconExternalLink } from '@tabler/icons-react';
import { MantineReactTable, MRT_ColumnDef, MRT_PaginationState } from 'mantine-react-table';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

export function FlaggedModelsList() {
  const queryUtils = trpc.useUtils();
  const router = useRouter();
  const page = isNumber(router.query.page) ? Number(router.query.page) : 1;
  const [pagination, setPagination] = useState<MRT_PaginationState>({
    pageIndex: page - 1,
    pageSize: 20,
  });

  const { data, isLoading, isFetching, isRefetching } = trpc.moderator.models.queryFlagged.useQuery(
    { page: pagination.pageIndex + 1, limit: pagination.pageSize }
  );
  const flaggedModels = data?.items ?? [];

  const resolveFlaggedModelMutation = trpc.moderator.models.resolveFlagged.useMutation({
    onSuccess: async () => {
      await queryUtils.moderator.models.queryFlagged.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Error resolving flagged model',
        error: new Error(error.message),
      });
    },
  });
  const handleResolveFlaggedModel = useCallback(
    async (id: number) => {
      await resolveFlaggedModelMutation.mutateAsync({ id });
    },
    [resolveFlaggedModelMutation]
  );

  const columns = useMemo<MRT_ColumnDef<(typeof flaggedModels)[number]>[]>(
    () => [
      {
        id: 'modelId',
        header: 'Model',
        accessorKey: 'model.name',
        size: 300,
        enableColumnActions: false,
        Cell: ({ row: { original } }) => (
          <Link href={`/models/${original.modelId}`} passHref legacyBehavior>
            <Anchor target="_blank">
              <div className="flex flex-nowrap gap-1">
                <IconExternalLink className="shrink-0 grow-0" size={16} />
                <Text>{original.model.name}</Text>
              </div>
            </Anchor>
          </Link>
        ),
      },
      {
        header: 'Details',
        accessorKey: 'details',
        enableColumnActions: false,
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        Cell: ({ row: { original } }) =>
          original.details ? (
            <ActionIcon
              size="sm"
              radius="xl"
              variant="subtle"
              onClick={() =>
                dialogStore.trigger({
                  component: DetailsModal,
                  props: { value: JSON.stringify(original.details, null, 2) },
                })
              }
            >
              <IconAlertCircle />
            </ActionIcon>
          ) : null,
      },
      {
        header: 'POI',
        accessorKey: 'poi',
        enableColumnActions: false,
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        Cell: ({ row: { original } }) => <FlagCell value={original.poi} />,
      },
      {
        header: 'NSFW',
        accessorKey: 'nsfw',
        enableColumnActions: false,
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        Cell: ({ row: { original } }) => <FlagCell value={original.nsfw} />,
      },
      {
        header: 'Trigger Words',
        accessorKey: 'triggerWords',
        enableColumnActions: false,
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        Cell: ({ row: { original } }) => <FlagCell value={original.triggerWords} />,
      },
      {
        header: 'Action',
        accessorKey: 'model.id',
        enableColumnActions: false,
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        Cell: ({ row: { original } }) => {
          const loading =
            resolveFlaggedModelMutation.variables?.id === original.modelId &&
            resolveFlaggedModelMutation.isLoading;

          return (
            <Button
              size="sm"
              onClick={() => handleResolveFlaggedModel(original.modelId)}
              loading={loading}
              compact
            >
              {loading ? 'Sending...' : 'Mark as Resolved'}
            </Button>
          );
        },
      },
    ],
    [
      handleResolveFlaggedModel,
      resolveFlaggedModelMutation.isLoading,
      resolveFlaggedModelMutation.variables?.id,
    ]
  );

  return (
    <div>
      <MantineReactTable
        columns={columns}
        data={flaggedModels}
        rowCount={data?.totalItems ?? 0}
        enableSorting={false}
        enableFilters={false}
        enableHiding={false}
        enableMultiSort={false}
        enableGlobalFilter={false}
        onPaginationChange={setPagination}
        enableStickyHeader
        enablePinning
        manualPagination
        mantineTableProps={{
          sx: { tableLayout: 'fixed' },
        }}
        initialState={{ density: 'xs', columnPinning: { left: ['model.name'] } }}
        state={{
          isLoading: isLoading || isRefetching,
          showProgressBars: isFetching,
          pagination,
        }}
      />
    </div>
  );
}

function FlagCell({ value }: { value: boolean }) {
  return value ? (
    <Badge color="yellow" size="sm">
      Needs Attention
    </Badge>
  ) : (
    <Badge color="green" size="sm">
      Clear
    </Badge>
  );
}

function DetailsModal({ value }: { value: string }) {
  const context = useDialogContext();

  return (
    <Modal {...context} title="Report Details" overflow="inside" centered>
      <JsonInput value={value} minRows={4} formatOnBlur autosize />
    </Modal>
  );
}
