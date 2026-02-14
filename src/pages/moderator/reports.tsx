import type { ComboboxItem, MantineSize } from '@mantine/core';
import {
  Anchor,
  Badge,
  Button,
  Container,
  Drawer,
  Group,
  Input,
  Loader,
  Menu,
  SegmentedControl,
  Stack,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { upperFirst } from 'lodash-es';
import type {
  MRT_ColumnDef,
  MRT_ColumnFiltersState,
  MRT_PaginationState,
  MRT_SortingState,
} from 'mantine-react-table';
import { MantineReactTable } from 'mantine-react-table';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import * as z from 'zod';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { env } from '~/env/client';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Form, InputTextArea, useForm } from '~/libs/form';
import { constants } from '~/server/common/constants';
import type { GetReportsProps } from '~/server/controllers/report.controller';
import type { SetReportStatusInput } from '~/server/schema/report.schema';
import { ReportEntity, reportStatusColorScheme } from '~/server/schema/report.schema';
import { ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { QS } from '~/utils/qs';
import { getDisplayName, splitUppercase } from '~/utils/string-helpers';

import { trpc } from '~/utils/trpc';

const limit = constants.reportingFilterDefaults.limit;

type ReportDetail = GetReportsProps['items'][0];
export default function Reports() {
  const router = useRouter();
  const page = router.query.page ? Number(router.query.page) : 1;
  const [type, setType] = useState(ReportEntity.Model);
  const [selected, setSelected] = useState<number>();
  const [columnFilters, setColumnFilters] = useState<MRT_ColumnFiltersState>([
    {
      id: 'reason',
      value: [
        ReportReason.AdminAttention,
        ReportReason.Claim,
        ReportReason.Ownership,
        ReportReason.TOSViolation,
        // ReportReason.Automated, // removing temporarily as per Seb
      ],
    },
    {
      id: 'status',
      value: [ReportStatus.Pending, ReportStatus.Processing],
    },
  ]);
  const [sorting, setSorting] = useState<MRT_SortingState>([{ id: 'createdAt', desc: true }]);
  const [pagination, setPagination] = useState<MRT_PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });

  const { data, isLoading, isFetching } = trpc.report.getAll.useQuery(
    {
      page: pagination.pageIndex + 1,
      limit: pagination.pageSize,
      type,
      filters: columnFilters,
      sort: sorting,
    },
    {
      keepPreviousData: true,
    }
  );
  const reports = useMemo(
    () => data?.items.map((x) => ({ ...x, page, type, limit })) ?? [],
    [data?.items, page, type]
  );

  const handlePageChange = (page: number) => {
    const [pathname, query] = router.asPath.split('?');
    router.replace({ pathname, query: { ...QS.parse(query), page } }, undefined, {
      shallow: true,
    });
    setSelected(undefined);
  };

  const handleTypeChange = (type: ReportEntity) => {
    handlePageChange(1);
    setType(type);
    setSelected(undefined);
  };

  const columns = useMemo<MRT_ColumnDef<(typeof reports)[0]>[]>(
    () => [
      {
        id: 'id',
        accesorKey: 'id',
        header: '',
        Cell: ({ row: { original: report } }) => (
          <Group gap="xs" wrap="nowrap">
            <Button size="compact-xs" onClick={() => setSelected(report.id)}>
              Details
            </Button>
            <Tooltip label="Open reported item" withArrow>
              <LegacyActionIcon
                component="a"
                href={getReportLink(report)}
                target="_blank"
                variant="subtle"
                size="sm"
              >
                <IconExternalLink />
              </LegacyActionIcon>
            </Tooltip>
          </Group>
        ),
        enableHiding: false,
        enableSorting: false,
        enableColumnFilter: false,
        enableColumnActions: false,
        width: 120,
      },
      {
        id: 'reason',
        header: 'Reason',
        accessorFn: (x) => splitUppercase(x.reason),
        filterFn: 'equals',
        filterVariant: 'multi-select',
        enableSorting: false,
        mantineFilterMultiSelectProps: {
          data: Object.values(ReportReason).map(
            (x) =>
              ({
                label: getDisplayName(x),
                value: x,
              } as ComboboxItem)
          ) as any,
        },
      },
      {
        accessorKey: 'status',
        header: 'Status',
        Cell: ({ row: { original: report } }) => (
          <ToggleReportStatus id={report.id} status={report.status} size="md" />
        ),
        filterFn: 'equals',
        filterVariant: 'multi-select',
        enableSorting: false,
        mantineFilterMultiSelectProps: {
          data: Object.values(ReportStatus).map(
            (x) =>
              ({
                label: getDisplayName(x),
                value: x,
              } as ComboboxItem)
          ) as any,
        },
      },
      {
        id: 'createdAt',
        accessorFn: (x) => formatDate(x.createdAt),
        header: 'Reported',
        filterVariant: 'date',
      },
      {
        id: 'reportedBy',
        accessorFn: (x) => x.user.username,
        header: 'Reported by',
        enableSorting: false,
        Cell: ({ row: { original: report } }) => (
          <Link legacyBehavior href={`/user/${report.user.username}`} passHref>
            <Text c="blue.4" component="a" target="_blank">
              {report.user.username}
            </Text>
          </Link>
        ),
      },
      {
        id: 'alsoReportedBy',
        header: 'Also reported by',
        accessorFn: (x) =>
          x.alsoReportedBy.length ? `${abbreviateNumber(x.alsoReportedBy.length)} Users` : null,
        enableSorting: false,
        enableColumnFilter: false,
      },
    ],
    []
  );

  return (
    <>
      <Meta title="Reports" deIndex />
      <Container size="xl" pb="xl">
        <Stack>
          <Group align="flex-end">
            <Title>Reports</Title>
            <SegmentedControl
              size="sm"
              data={Object.values(ReportEntity).map((x) => ({ label: upperFirst(x), value: x }))}
              onChange={(type) => handleTypeChange(type as ReportEntity)}
              value={type}
            />
          </Group>
          <MantineReactTable
            columns={columns}
            data={reports}
            manualFiltering
            manualPagination
            manualSorting
            onColumnFiltersChange={setColumnFilters}
            onPaginationChange={setPagination}
            onSortingChange={setSorting}
            enableMultiSort={false}
            rowCount={data?.totalItems ?? 0}
            enableStickyHeader
            enableHiding={false}
            enableGlobalFilter={false}
            mantineTableContainerProps={{
              className: 'max-h-[calc(100vh-360px)]',
            }}
            initialState={{ density: 'md' }}
            state={{
              isLoading,
              pagination,
              columnFilters,
              showProgressBars: isFetching,
              sorting,
            }}
          />
        </Stack>
      </Container>
      {data && (
        <ReportDrawer
          report={data.items.find((x) => x.id === selected)}
          onClose={() => setSelected(undefined)}
          type={type}
        />
      )}
    </>
  );
}

const schema = z.object({ internalNotes: z.string().nullish() });

function ReportDrawer({
  report,
  onClose,
  type,
}: {
  report?: ReportDetail;
  onClose: () => void;
  type: ReportEntity;
}) {
  const theme = useMantineTheme();
  const mobile = useIsMobile();
  const href = useMemo(() => (report ? getReportLink(report) : null), [report]);
  const queryUtils = trpc.useUtils();

  const form = useForm({
    schema,
    defaultValues: { internalNotes: report?.internalNotes ?? null },
  });
  const { isDirty } = form.formState;

  const updateReportMutation = trpc.report.update.useMutation({
    async onSuccess(results) {
      await queryUtils.report.getAll.invalidate();
      form.reset({
        internalNotes: results.internalNotes,
      });
      showSuccessNotification({
        title: 'Report updated successfully',
        message: 'Internal notes have been saved',
      });
      if (mobile) onClose?.();
    },
    onError(error) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });
  const handleSaveReport = (data: z.infer<typeof schema>) => {
    if (report) updateReportMutation.mutate({ ...report, ...data });
  };

  useEffect(() => {
    if (report)
      form.reset({
        internalNotes: report.internalNotes,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  return (
    <Drawer
      withOverlay={false}
      opened={!!report}
      onClose={onClose}
      position={mobile ? 'bottom' : 'right'}
      title={`${upperFirst(type)} Report Details`}
      size={mobile ? '100%' : 'xl'}
      padding="md"
      shadow="sm"
      zIndex={500}
      classNames={{
        content: 'border-l border-l-gray-3 dark:border-l-dark-4',
      }}
    >
      {report && (
        <Stack>
          {href && (
            <Link legacyBehavior href={href} passHref>
              <Anchor size="sm" target="_blank">
                <Group gap={4}>
                  <Text inherit>View {type}</Text>
                  <IconExternalLink size={14} stroke={1.5} />
                </Group>
              </Anchor>
            </Link>
          )}
          <ReportDetails report={report} />
          <Input.Wrapper
            label="Status"
            description="Use this input to set the status of the report"
            descriptionProps={{ sx: { marginBottom: 5 } }}
          >
            <ToggleReportStatus id={report.id} status={report.status} size="md" />
          </Input.Wrapper>
          <Form form={form} onSubmit={handleSaveReport}>
            <Stack>
              <InputTextArea
                name="internalNotes"
                label="Internal Notes"
                description="Leave an internal note for future reference (optional)"
                placeholder="Add note..."
                minRows={2}
                autosize
              />
              <Group justify="flex-end">
                <Button type="submit" disabled={!isDirty} loading={updateReportMutation.isLoading}>
                  Save
                </Button>
              </Group>
            </Stack>
          </Form>
        </Stack>
      )}
    </Drawer>
  );
}

function ReportDetails({ report }: { report: ReportDetail }) {
  const { details } = report;
  if (!details) return null;
  if (typeof details === 'string' || typeof details === 'number' || typeof details === 'boolean')
    return <>{details}</>;
  if (Array.isArray(details)) return <>Bad data</>;

  const entries = Object.entries(details);
  if (entries.length === 0) return null;

  const detailItems = entries
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const label = upperFirst(key);
      if (key === 'images' && Array.isArray(value))
        return {
          label,
          value: (
            <Stack gap="xs">
              {value.map((cuid, i) => {
                if (typeof cuid !== 'string') return null;
                return (
                  <Text
                    key={cuid}
                    component="a"
                    c="blue.4"
                    href={getEdgeUrl(cuid, { width: 450, name: cuid })}
                    target="_blank"
                    rel="nofollow noreferrer"
                  >
                    Image {i + 1}
                  </Text>
                );
              })}
            </Stack>
          ),
        };
      if (key === 'comment' && typeof value === 'string')
        return {
          label,
          value: (
            <ContentClamp maxHeight={100}>
              <RenderHtml html={value} />
            </ContentClamp>
          ),
        };

      return { label, value: value?.toString() };
    });

  if (report.reason === 'Ownership') {
    detailItems.unshift({
      label: 'Claiming User',
      value: (
        <Text component="a" href={`mailto:${report.user.email}}`} target="_blank">
          {report.user.username} ({report.user.email})
        </Text>
      ),
    });
  }

  return <DescriptionTable items={detailItems} labelWidth="30%" />;
}

const getReportLink = (report: ReportDetail) => {
  if (report.model) return `/models/${report.model.id}`;
  else if (report.resourceReview) return `/reviews/${report.resourceReview.id}`;
  else if (report.comment)
    return `/models/${report.comment.modelId}/?dialog=commentThread&commentId=${
      report.comment.parentId ?? report.comment.id
    }&highlight=${report.comment.id}`;
  else if (report.image) return `/images/${report.image.id}`;
  else if (report.article) return `/articles/${report.article.id}`;
  else if (report.post) return `/posts/${report.post.id}`;
  else if (report.reportedUser) return `/user/${report.reportedUser.username}`;
  else if (report.collection) return `/collections/${report.collection.id}`;
  else if (report.bounty) return `/bounties/${report.bounty.id}`;
  else if (report.bountyEntry)
    return `/bounties/${report.bountyEntry.bountyId}/entries/${report.bountyEntry.id}`;
  else if (report.commentV2?.commentV2) return `/comments/v2/${report.commentV2.commentV2.id}`;
  else if (report.comicProject) return `/comics/${report.comicProject.id}`;
  else if (report.chat)
    return !!env.NEXT_PUBLIC_CHAT_LOOKUP_URL
      ? `${env.NEXT_PUBLIC_CHAT_LOOKUP_URL}${report.chat.id}`
      : undefined;
};

function ToggleReportStatus({ id, status, size }: SetReportStatusInput & { size?: MantineSize }) {
  // TODO.Briant - create a helper function for this
  const queryClient = useQueryClient();
  // TODO.manuel - not sure why we use useQueryClient here to optimistically update the query
  // but doing this hotfix for now
  const queryUtils = trpc.useUtils();

  const { mutate, isLoading } = trpc.report.setStatus.useMutation({
    onSuccess(_, request) {
      const queryKey = getQueryKey(trpc.report.getAll);
      queryClient.setQueriesData(
        { queryKey, exact: false },
        produce((old: any) => {
          const item = old?.items?.find((x: any) => x.id == id);
          if (item) item.status = request.status;
        })
      );
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to set report status',
        error: new Error(error.message),
      });
    },
    async onSettled() {
      await queryUtils.report.getAll.invalidate();
    },
  });
  const statusColor = reportStatusColorScheme[status];

  return (
    <Menu>
      <Menu.Target>
        <Badge color={statusColor} size={size} style={{ cursor: 'pointer' }}>
          {isLoading ? <Loader type="dots" size="sm" mx="md" color={statusColor} /> : status}
        </Badge>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Set Status</Menu.Label>
        <Menu.Divider />
        {Object.values(ReportStatus)
          .filter((x) => x !== status)
          .map((reportStatus, i) => (
            <Menu.Item key={i} onClick={() => mutate({ id, status: reportStatus })}>
              {reportStatus}
            </Menu.Item>
          ))}
      </Menu.Dropdown>
    </Menu>
  );
}

// function ReportReason({reason, details}: {reason: ReportReason, details:})

// function ReportAction({ entityId, entityType }: { entityId: number; entityType: ReportEntity }) {
//   return <></>;
// }
