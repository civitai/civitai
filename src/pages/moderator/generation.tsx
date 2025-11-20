import { ActionIcon, Button, Container, Group, Stack, Text, Title } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { MRT_ColumnDef, MRT_PaginationState } from 'mantine-react-table';
import { MantineReactTable } from 'mantine-react-table';
import { useCallback, useMemo, useState } from 'react';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { useUnsupportedResources } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import type { GenerationGetResources } from '~/types/router';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };

    return { props: {} };
  },
});

export default function GenerationPage() {
  const [pagination, setPagination] = useState<MRT_PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });

  const { unavailableResources, toggleUnavailableResource } = useUnsupportedResources();
  const { data, isInitialLoading, isFetching } = trpc.generation.getResources.useQuery(
    { ids: unavailableResources, page: pagination.pageIndex + 1, limit: pagination.pageSize },
    { enabled: unavailableResources.length > 0, keepPreviousData: true }
  );

  const handleAddResource = async (resourceId: number) => {
    if (unavailableResources.includes(resourceId)) return;
    await toggleUnavailableResource(resourceId);
  };

  const handleRemoveResource = useCallback(
    async (resourceId: number) => {
      if (!unavailableResources.includes(resourceId)) return;
      await toggleUnavailableResource(resourceId);
    },
    [toggleUnavailableResource, unavailableResources]
  );

  const columns = useMemo<MRT_ColumnDef<GenerationGetResources[number]>[]>(
    () => [
      { id: 'modelId', header: 'Model', accessorKey: 'modelName', size: 300 },
      { id: 'id', header: 'Version', accessorKey: 'name' },
      {
        header: 'Type',
        accessorKey: 'modelType',
        Cell: ({ cell }) => getDisplayName(cell.getValue<string>()),
      },
      {
        header: 'Action',
        mantineTableHeadCellProps: { align: 'right' },
        mantineTableBodyCellProps: { align: 'right' },
        size: 80,
        Cell: ({ row: { original } }) => (
          <LegacyActionIcon color="red" onClick={() => handleRemoveResource(original.id)}>
            <IconTrash />
          </LegacyActionIcon>
        ),
      },
    ],
    [handleRemoveResource]
  );

  return (
    <>
      <Meta title="Generation" deIndex />
      <Container size="md">
        <Stack gap="xl">
          <Group justify="space-between">
            <Stack gap={0}>
              <Title>Unavailable Resources</Title>
              <Text c="dimmed">List of temporarily unavailable resources</Text>
            </Stack>
            <Button
              leftSection={<IconPlus />}
              onClick={() =>
                openResourceSelectModal({ onSelect: (resource) => handleAddResource(resource.id) })
              }
            >
              Add
            </Button>
          </Group>
          <MantineReactTable
            columns={columns}
            data={data?.items ?? []}
            rowCount={data?.totalItems ?? 0}
            enableSorting={false}
            enableFilters={false}
            enableHiding={false}
            enableMultiSort={false}
            enableGlobalFilter={false}
            onPaginationChange={setPagination}
            enableStickyHeader
            manualPagination
            mantineTableProps={{
              style: { tableLayout: 'fixed' },
            }}
            initialState={{ density: 'xs' }}
            state={{
              isLoading: isInitialLoading,
              showProgressBars: isFetching,
              pagination,
            }}
          />
        </Stack>
      </Container>
    </>
  );
}
