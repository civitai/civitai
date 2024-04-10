import { ActionIcon, Button, Container, Group, Stack, Text, Title } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { MantineReactTable, MRT_ColumnDef, MRT_PaginationState } from 'mantine-react-table';
import { useCallback, useMemo, useState } from 'react';
import { openResourceSelectModal } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal';
import { useUnsupportedResources } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { Meta } from '~/components/Meta/Meta';
import { Generation } from '~/server/services/generation/generation.types';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { GenerationGetResources } from '~/types/router';
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

  const handleAddResource = async (resource: Generation.Resource) => {
    if (unavailableResources.includes(resource.id)) return;
    await toggleUnavailableResource(resource.id);
  };

  const handleRemoveResource = useCallback(
    async (resource: Generation.Resource) => {
      if (!unavailableResources.includes(resource.id)) return;
      await toggleUnavailableResource(resource.id);
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
          <ActionIcon color="red" onClick={() => handleRemoveResource(original)}>
            <IconTrash />
          </ActionIcon>
        ),
      },
    ],
    [handleRemoveResource]
  );

  return (
    <>
      <Meta title="Generation" deIndex />
      <Container size="md">
        <Stack spacing="xl">
          <Group position="apart">
            <Stack spacing={0}>
              <Title>Unavailable Resources</Title>
              <Text color="dimmed">List of temporarily unavailable resources</Text>
            </Stack>
            <Button
              leftIcon={<IconPlus />}
              onClick={() => openResourceSelectModal({ onSelect: handleAddResource })}
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
              sx: { tableLayout: 'fixed' },
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
