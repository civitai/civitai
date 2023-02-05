import {
  Container,
  Table,
  Stack,
  Group,
  Pagination,
  Text,
  Center,
  Loader,
  LoadingOverlay,
  Badge,
  Menu,
  SegmentedControl,
  Drawer,
  useMantineTheme,
  Title,
  Button,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import { GetServerSideProps } from 'next/types';
import { useRouter } from 'next/router';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { trpc } from '~/utils/trpc';
import { QS } from '~/utils/qs';
import { formatDate } from '~/utils/date-helpers';
import Link from 'next/link';
import {
  ReportEntity,
  reportStatusColorScheme,
  SetReportStatusInput,
} from '~/server/schema/report.schema';
import { Prisma, ReportStatus } from '@prisma/client';
import { useState, useMemo } from 'react';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { GetReportsProps } from '~/server/controllers/report.controller';
import produce from 'immer';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { splitUppercase } from '~/utils/string-helpers';
import { IconExternalLink } from '@tabler/icons';
import { upperFirst } from 'lodash';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerAuthSession(context);
  if (!session?.user?.isModerator || session.user?.bannedAt) {
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };
  }
  return { props: {} };
};

type ReportDetail = GetReportsProps['items'][0];
export default function Reports() {
  const router = useRouter();
  const page = router.query.page ? Number(router.query.page) : 1;
  const limit = 50;
  const [type, setType] = useState(ReportEntity.Model);
  const [selected, setSelected] = useState<number>();

  const { data, isLoading, isFetching } = trpc.report.getAll.useQuery({
    page,
    limit,
    type,
  });

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

  return (
    <Container pb="xl">
      <Stack>
        <Title>Reports</Title>
        <SegmentedControl
          data={Object.values(ReportEntity).map((x) => ({ label: upperFirst(x), value: x }))}
          onChange={handleTypeChange}
          value={type}
        />
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isLoading || isFetching} />
          <Table>
            <thead>
              <tr>
                <th></th>
                <th>Reason</th>
                <th>Status</th>
                <th>Created</th>
                <th>Reported by</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Group spacing="xs">
                      <Button compact size="xs" onClick={() => setSelected(item.id)}>
                        Details
                      </Button>
                      <Tooltip label="Open reported item" withArrow>
                        <ActionIcon
                          component="a"
                          href={getReportLink(item)}
                          target="_blank"
                          variant="subtle"
                          size="sm"
                        >
                          <IconExternalLink />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </td>
                  <td>{splitUppercase(item.reason)}</td>
                  <td>
                    <ToggleReportStatus
                      id={item.id}
                      status={item.status}
                      page={page}
                      type={type}
                      limit={limit}
                    />
                  </td>
                  <td>{formatDate(item.createdAt)}</td>
                  <td>
                    <Link href={`/user/${item.user.username}`} passHref>
                      <Text variant="link" component="a" target="_blank">
                        {item.user.username}
                      </Text>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
        {data?.totalPages > 1 && (
          <Group position="apart">
            <Text>Total {data.totalItems} items</Text>

            <Pagination page={page} onChange={handlePageChange} total={data.totalPages} />
          </Group>
        )}
      </Stack>
      <ReportDrawer
        report={data?.items.find((x) => x.id === selected)}
        onClose={() => setSelected(undefined)}
        type={type}
        page={page}
        limit={limit}
      />
    </Container>
  );
}

function ReportDrawer({
  report,
  onClose,
  type,
  page,
  limit,
}: {
  report?: ReportDetail;
  onClose: () => void;
  type: ReportEntity;
  page: number;
  limit: number;
}) {
  const theme = useMantineTheme();
  const href = useMemo(() => (report ? getReportLink(report) : null), [report]);
  return (
    <Drawer
      withOverlay={false}
      opened={!!report}
      onClose={onClose}
      position="right"
      size={500}
      padding="md"
      shadow="sm"
      styles={{
        drawer: {
          borderLeft: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
          }`,
        },
      }}
    >
      {report && (
        <Stack>
          <ToggleReportStatus
            id={report.id}
            status={report.status}
            page={page}
            type={type}
            limit={limit}
          />
          {href && (
            <Link href={href} passHref>
              <Button component="a" target="_blank">
                View {type}
              </Button>
            </Link>
          )}
          <ReportDetails report={report} />
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
    .filter(([key, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const label = upperFirst(key);
      if (key === 'images' && Array.isArray(value))
        return {
          label,
          value: (
            <Stack>
              {value.map((cuid, i) => {
                if (typeof cuid !== 'string') return null;
                return (
                  <a
                    key={cuid}
                    href={getEdgeUrl(cuid, { width: 450 })}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Image {i + 1}
                  </a>
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

  if (report.image) {
    const sourceHref = report.image.reviewId
      ? `/models/${report.image.modelId}/?modal=reviewThread&reviewId=${report.image.reviewId}`
      : `/models/${report.image.modelId}`;

    detailItems.push({
      label: 'Source',
      value: (
        <Text component="a" href={sourceHref} variant="link" target="_blank">
          {report.image.reviewId ? 'Review' : 'Model Samples'}
        </Text>
      ),
    });
  }

  return <DescriptionTable items={detailItems} labelWidth="30%" />;
}

const getReportLink = (report: ReportDetail) => {
  if (report.model) return `/models/${report.model.id}`;
  else if (report.review)
    return `/models/${report.review.modelId}/?modal=reviewThread&reviewId=${report.review.id}`;
  else if (report.comment)
    return `/models/${report.comment.modelId}/?modal=commentThread&commentId=${
      report.comment.parentId ?? report.comment.id
    }&highlight=${report.comment.id}`;
  else if (report.image) {
    const returnUrl = report.image.reviewId
      ? `/models/${report.image.modelId}/?modal=reviewThread&reviewId=${report.image.reviewId}`
      : `/models/${report.image.modelId}`;
    const parts = [`returnUrl=${encodeURIComponent(returnUrl)}`];
    if (report.image.modelId) parts.push(`modelId=${report.image.modelId}`);
    if (report.image.modelVersionId) parts.push(`modelVersionId=${report.image.modelVersionId}`);
    if (report.image.reviewId) parts.push(`reviewId=${report.image.reviewId}`);
    return `/gallery/${report.image.id}/?${parts.join('&')}`;
  }
};

function ToggleReportStatus({
  id,
  status,
  type,
  page,
  limit,
}: SetReportStatusInput & { type: ReportEntity; page: number; limit: number }) {
  const queryUtils = trpc.useContext();
  // const [status, setStatus] = useState(initialStatus);

  const { mutate, isLoading } = trpc.report.setStatus.useMutation({
    async onSuccess(response, request) {
      // setStatus(request.status);
      await queryUtils.report.getAll.setData(
        { type, page, limit },
        produce((old) => {
          if (old) {
            const index = old.items.findIndex((x) => x.id === id);
            old.items[index].status = request.status;
          }
        })
      );
    },
  });

  return (
    <Menu>
      <Menu.Target>
        <Badge color={reportStatusColorScheme[status]} sx={{ cursor: 'pointer' }}>
          {isLoading ? <Loader variant="dots" size="sm" /> : status}
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
