import { MRT_ColumnDef, MRT_PaginationState, MantineReactTable } from 'mantine-react-table';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { QS } from '~/utils/qs';
import { formatDate, formatDateNullable } from '~/utils/date-helpers';
import { Container, Stack, Group, Title, Badge } from '@mantine/core';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NotFound } from '~/components/AppLayout/NotFound';

const limit = 20;

export default function CsamReports() {
  const router = useRouter();
  const page = router.query.page ? Number(router.query.page) : 1;

  const { csamReports } = useFeatureFlags();

  const [pagination, setPagination] = useState<MRT_PaginationState>({
    pageIndex: 0,
    pageSize: limit,
  });

  const { data, isLoading, isFetching } = trpc.csam.getCsamReports.useQuery(
    {
      page: pagination.pageIndex + 1,
      limit: pagination.pageSize,
    },
    {
      keepPreviousData: true,
    }
  );

  const { data: stats } = trpc.csam.getCsamReportsStats.useQuery();

  const reports = useMemo(
    () => data?.items.map((x) => ({ ...x, page, limit })) ?? [],
    [data?.items, page]
  );

  // const handlePageChange = (page: number) => {
  //   const [pathname, query] = router.asPath.split('?');
  //   router.replace({ pathname, query: { ...QS.parse(query), page } }, undefined, {
  //     shallow: true,
  //   });
  // };

  const columns = useMemo<MRT_ColumnDef<(typeof reports)[0]>[]>(
    () => [
      {
        id: 'userId',
        header: 'User Id',
        accessorFn: (x) => (x.user ? x.user.username : undefined),
      },
      {
        id: 'reportedById',
        header: 'Reported By',
        accessorFn: (x) => (x.reportedBy ? x.reportedBy.username : undefined),
      },

      {
        id: 'createdAt',
        header: 'Created At',
        accessorFn: (x) => formatDateNullable(x.createdAt),
      },
      {
        id: 'reportSentAt',
        header: 'Reported Sent At',
        accessorFn: (x) => formatDateNullable(x.reportSentAt),
      },
      {
        id: 'archivedAt',
        header: 'Archived At',
        accessorFn: (x) => formatDateNullable(x.archivedAt),
      },
      {
        id: 'contentRemovedAt',
        header: 'Content Removed At',
        accessorFn: (x) => formatDateNullable(x.contentRemovedAt),
      },
      {
        id: 'reportId',
        header: 'Report Id',
      },
    ],
    []
  );

  const statsArr = Object.entries(stats ?? {})
    .filter(([_, count]) => count > 0)
    .map(([key, count]) => ({ label: key, count }));

  if (!csamReports) return <NotFound />;

  return (
    <Container size="xl">
      <Stack>
        <Group position="apart">
          <Title>Csam Reports</Title>
          {statsArr.length > 0 && (
            <Group>
              {statsArr.map(({ label, count }) => (
                <Badge key={label} rightSection={count}>
                  {label}
                </Badge>
              ))}
            </Group>
          )}
        </Group>
        <MantineReactTable
          columns={columns}
          data={reports}
          manualPagination
          onPaginationChange={setPagination}
          enableMultiSort={false}
          rowCount={data?.totalItems ?? 0}
          enableStickyHeader
          enableHiding={false}
          enableGlobalFilter={false}
          mantineTableContainerProps={{
            sx: { maxHeight: 'calc(100vh - 360px)' },
          }}
          initialState={{
            density: 'sm',
          }}
          state={{
            isLoading,
            pagination,
            showProgressBars: isFetching,
          }}
        />
      </Stack>
    </Container>
  );
}
