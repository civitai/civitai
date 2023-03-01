import {
  Box,
  Container,
  Table,
  Stack,
  Group,
  Pagination,
  Text,
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
  Input,
  MantineSize,
  Anchor,
  ScrollArea,
} from '@mantine/core';
import { ReportStatus } from '@prisma/client';
import { IconExternalLink } from '@tabler/icons';
import produce from 'immer';
import upperFirst from 'lodash/upperFirst';
import Link from 'next/link';
import { GetServerSideProps } from 'next/types';
import { useRouter } from 'next/router';
import { useState, useMemo, useEffect } from 'react';
import { z } from 'zod';

import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { trpc } from '~/utils/trpc';
import { QS } from '~/utils/qs';
import { formatDate } from '~/utils/date-helpers';
import {
  ReportEntity,
  reportStatusColorScheme,
  SetReportStatusInput,
} from '~/server/schema/report.schema';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { GetReportsProps } from '~/server/controllers/report.controller';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { splitUppercase } from '~/utils/string-helpers';
import { constants } from '~/server/common/constants';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Meta } from '~/components/Meta/Meta';
import { Form, InputTextArea, useForm } from '~/libs/form';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';

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

const limit = constants.reportingFilterDefaults.limit;

type ReportDetail = GetReportsProps['items'][0];
export default function Reports() {
  const router = useRouter();
  const page = router.query.page ? Number(router.query.page) : 1;
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
    <>
      <Meta title="Reports" />
      <Container size="xl" pb="xl">
        <Stack>
          <Title>Reports</Title>
          <SegmentedControl
            data={Object.values(ReportEntity).map((x) => ({ label: upperFirst(x), value: x }))}
            onChange={handleTypeChange}
            value={type}
          />
          <ScrollArea style={{ position: 'relative' }}>
            <LoadingOverlay visible={isLoading || isFetching} />
            <Table striped>
              <thead>
                <tr>
                  <th></th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Reported by</th>
                  <th>Also reported by</th>
                </tr>
              </thead>
              <tbody>
                {data &&
                  data.items.map((item) => (
                    <Box
                      component="tr"
                      key={item.id}
                      sx={(theme) => ({
                        backgroundColor:
                          selected === item.id
                            ? theme.colorScheme === 'dark'
                              ? `${theme.colors.dark[4]} !important`
                              : `${theme.colors.gray[2]} !important`
                            : undefined,
                      })}
                    >
                      <td>
                        <Group spacing="xs" noWrap>
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
                      <td>
                        {item.alsoReportedBy.length > 0
                          ? `${abbreviateNumber(item.alsoReportedBy.length)} Users`
                          : null}
                      </td>
                    </Box>
                  ))}
              </tbody>
            </Table>
          </ScrollArea>
          {data && data.totalPages > 1 && (
            <Group position="apart">
              <Text>Total {data.totalItems} items</Text>

              <Pagination page={page} onChange={handlePageChange} total={data.totalPages} />
            </Group>
          )}
        </Stack>
      </Container>
      {data && (
        <ReportDrawer
          report={data.items.find((x) => x.id === selected)}
          onClose={() => setSelected(undefined)}
          type={type}
          page={page}
          limit={limit}
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
  const mobile = useIsMobile();
  const href = useMemo(() => (report ? getReportLink(report) : null), [report]);
  const queryUtils = trpc.useContext();

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
          {href && (
            <Link href={href} passHref>
              <Anchor size="sm" target="_blank">
                <Group spacing={4}>
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
            <ToggleReportStatus
              id={report.id}
              status={report.status}
              page={page}
              type={type}
              limit={limit}
              size="md"
            />
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
              <Group position="right">
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
            <Stack spacing="xs">
              {value.map((cuid, i) => {
                if (typeof cuid !== 'string') return null;
                return (
                  <Text
                    key={cuid}
                    component="a"
                    variant="link"
                    href={getEdgeUrl(cuid, { width: 450, name: cuid })}
                    target="_blank"
                    rel="noreferrer"
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

  if (report.reason === 'Ownership') {
    detailItems.unshift({
      label: 'Claiming User',
      value: (
        <Text component="a" href={`mailto:${report.user.email}}`} variant="link" target="_blank">
          {report.user.username} ({report.user.email})
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
  size,
}: SetReportStatusInput & { type: ReportEntity; page: number; limit: number; size?: MantineSize }) {
  const queryUtils = trpc.useContext();
  // const [status, setStatus] = useState(initialStatus);

  const { mutate, isLoading } = trpc.report.setStatus.useMutation({
    onSuccess(_, request) {
      // setStatus(request.status);
      queryUtils.report.getAll.setData(
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
        <Badge color={reportStatusColorScheme[status]} size={size} sx={{ cursor: 'pointer' }}>
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
