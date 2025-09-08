import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TooltipProps } from '@mantine/core';
import {
  Text,
  Chip,
  Card,
  Badge,
  Pagination,
  Select,
  ActionIcon,
  Tooltip,
  Paper,
  Alert,
} from '@mantine/core';
import { NoContent } from '~/components/NoContent/NoContent';
import { NextLink } from '~/components/NextLink/NextLink';
import type {
  ConsumerStrike,
  ConsumerStikesGroup,
} from '~/server/http/orchestrator/flagged-consumers';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Tabs } from '@mantine/core';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { create } from 'zustand';
import { useLocalStorage } from '@mantine/hooks';
import { IconAlertTriangle, IconCheck, IconSquareOff } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { uniqBy } from 'lodash-es';
import { isDefined } from '~/utils/type-guards';
import { showErrorNotification } from '~/utils/notifications';
import { Page } from '~/components/AppLayout/Page';

const useStore = create<Record<string, boolean>>(() => ({}));
const resetState = () => {
  console.log('resetting');
  useStore.setState({}, true);
};

function FlaggedConsumerId() {
  const router = useRouter();
  const consumerId = router.query.consumerId as string;
  const userId = Number(consumerId.split('-')[1]);

  const { data: user } = trpc.user.getById.useQuery({ id: userId });
  const { data, isLoading } = trpc.orchestrator.getFlaggedConsumerStrikes.useQuery({ consumerId });

  useEffect(() => resetState, []);

  const filtered = useMemo(() => {
    if (!data) return;
    const groups = [...new Set(data.map((x) => x.status))];
    const grouped = groups.map((group) => ({
      status: group,
      strikes: data.filter(({ status }) => status === group).flatMap((x) => x.strikes),
    }));
    return grouped.map((group) => ({
      ...group,
      strikes: uniqBy(
        group.strikes.filter((x) => x.job?.blobs),
        'job.id'
      ),
    }));
  }, [data]);

  return (
    <div className="container relative max-w-xl">
      <div className="flex gap-3">
        <div className="flex-1">
          <div className="flex justify-between">
            <h1 className="mb-3 text-2xl font-bold">
              Username:{' '}
              {user?.username && (
                <NextLink href={`/user/${user.username}`}>{user.username}</NextLink>
              )}
            </h1>
          </div>
          {isLoading ? (
            <PageLoader />
          ) : !filtered ? (
            <NoContent />
          ) : (
            <FlaggedConsumerContent data={filtered} />
          )}
        </div>
        <div>{filtered && <SelectedCount userId={userId} data={filtered} />}</div>
      </div>
    </div>
  );
}

function FlaggedConsumerContent({ data }: { data: ConsumerStikesGroup[] }) {
  const [status, setStatus] = useState<string | null>('unreviewed');
  const _status = status ?? data[0].status;

  return (
    <Tabs variant="outline" value={_status} onChange={setStatus} keepMounted={false}>
      <Tabs.List>
        {data.map(({ status, strikes }) => (
          <Tabs.Tab key={status} value={status}>
            {status} - {strikes.length}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {data.map(({ status, strikes }) => (
        <Tabs.Panel key={status} value={status} className="my-3 flex flex-col gap-3">
          <FlaggedConsumerStrikes data={strikes} />
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}

function FlaggedConsumerStrikes({ data }: { data: ConsumerStrike[] }) {
  const reasons = [...new Set(data.map((x) => x.strike.reason))];
  const [activePage, setPage] = useState(1);
  const [pageSize, setPageSize] = useLocalStorage({ key: 'page-size', defaultValue: 100 });
  const [selectedReasons, setSelectedReasons] = useState<string[]>(reasons);
  const filtered = useMemo(
    () => data.filter((x) => selectedReasons.includes(x.strike.reason)),
    [data, selectedReasons]
  );
  const totalPages = Math.ceil(filtered.length / pageSize);
  const _activePage = totalPages < activePage ? totalPages : activePage;

  const items = useMemo(() => {
    return filtered.slice(_activePage - 1, pageSize);
  }, [filtered, _activePage, pageSize]);

  const navigation = (
    <div className="flex items-center justify-between">
      <div className="flex gap-1">
        <Chip.Group value={selectedReasons} onChange={setSelectedReasons} multiple>
          {reasons.map((reason) => (
            <Chip key={reason} value={reason}>
              {reason}
            </Chip>
          ))}
        </Chip.Group>
      </div>
      <div className="flex items-center justify-end gap-3">
        <Select
          value={pageSize.toString()}
          data={['25', '50', '75', '100']}
          onChange={(value) => setPageSize(Number(value))}
        />
        <Pagination total={totalPages} value={_activePage} onChange={setPage} />
      </div>
    </div>
  );

  return (
    <>
      <div className="flex flex-col gap-3">
        {navigation}
        {!items.length && <Alert>{`You're all caught up!`}</Alert>}
        {items.map(({ strike, job }, index) => (
          <Card key={index} withBorder padding="sm">
            <div className="mb-1 grid grid-cols-4 gap-1">
              {job.blobs?.map((blob, i) => (
                <ConsumerStrikePreviewImage key={i} {...blob} />
              ))}
            </div>
            <Text size="sm">
              <Badge component="span" size="sm">
                Prompt
              </Badge>{' '}
              <Badge component="span" size="sm">
                {strike.reason}
              </Badge>{' '}
              {job.prompt}
            </Text>
            {job.negativePrompt && (
              <Text size="sm">
                <Badge component="span" size="sm">
                  Negative Prompt
                </Badge>{' '}
                {job.negativePrompt}
              </Text>
            )}
          </Card>
        ))}
        {navigation}
      </div>
    </>
  );
}

function ConsumerStrikePreviewImage({ id, previewUrl }: { id: string; previewUrl: string }) {
  const active = useStore(useCallback((state) => state[previewUrl], [previewUrl]));

  function toggleSelect() {
    useStore.setState((state) => ({ [previewUrl]: !state[previewUrl] }));
  }

  return (
    <Card
      withBorder
      className="border-2 p-0"
      onClick={toggleSelect}
      style={{ borderColor: active ? 'blue' : undefined }}
    >
      <EdgeMedia2
        src={previewUrl}
        type={id.includes('.mp4') ? 'video' : 'image'}
        disableWebm
        disablePoster
        muted
        loading="lazy"
      />
    </Card>
  );
}

function handleConfirm(onConfirm: () => void) {
  dialogStore.trigger({
    component: ConfirmDialog,
    props: {
      title: '⚠️ Please confirm',
      message: `Definitely want to confirm this`,
      labels: { cancel: 'Cancel', confirm: 'Confirm' },
      onConfirm,
    },
  });
}

function SelectedCount({ userId, data }: { userId: number; data: ConsumerStikesGroup[] }) {
  const count = useStore((state) => Object.values(state).filter(Boolean).length);
  const router = useRouter();

  const onSuccess = () => {
    if (history.length === 1) router.push('/moderator/orchestrator/flagged');
    else router.back();
  };

  const reviewConsumerStrikes = trpc.orchestrator.reviewConsumerStrikes.useMutation({
    onSuccess,
    onError: () => showErrorNotification({ error: new Error('failed to submit review') }),
  });
  const reportCsam = trpc.csam.createReport.useMutation({
    onSuccess,
    onError: () => showErrorNotification({ error: new Error('failed to submit csam report') }),
  });

  const tooltipProps: Omit<TooltipProps, 'label' | 'children'> = {
    position: 'bottom',
    withArrow: true,
    withinPortal: true,
    variant: 'filled',
  };

  const iconProps = {
    size: '1.25rem',
  };

  const actionIconProps = {
    size: 'xl',
  };

  function handleReview() {
    handleConfirm(() => {
      reviewConsumerStrikes.mutate({ userId });
    });
  }

  function handleReportCsam() {
    // TODO - collate data
    const selected = Object.keys(useStore.getState());
    const jobs = data
      .flatMap((x) =>
        x.strikes.map(({ strike, job }) => {
          if (!job || !job.blobs) return null;
          return {
            blobs: job.blobs
              .filter((blob) => selected.includes(blob.previewUrl))
              .map(({ previewUrl }) => ({ url: previewUrl })),
            jobId: job.id,
            prompt: job.prompt,
            negativePrompt: job.negativePrompt,
            resources: job.resources,
            dateTime: new Date(strike.dateTime),
          };
        })
      )
      .filter(isDefined);
    // .filter(x => x.job && x.job.blobs?.some((blob) => ))
    handleConfirm(() => {
      reportCsam.mutate({ type: 'GeneratedImage', userId, details: { generatedImages: jobs } });
    });
  }

  return (
    <Paper
      withBorder
      className="flex flex-col items-center justify-center"
      style={{
        position: 'sticky',
        top: 'var(--header-height,0)',
      }}
    >
      {count === 0 ? (
        <>
          <Tooltip label="Mark as reviewed" {...tooltipProps}>
            <ActionIcon
              onClick={handleReview}
              color="green"
              loading={reviewConsumerStrikes.isLoading}
              {...actionIconProps}
            >
              <IconCheck {...iconProps} />
            </ActionIcon>
          </Tooltip>
        </>
      ) : (
        <>
          <Text className="flex items-center justify-center font-bold" style={{ height: 42 }}>
            {count}
          </Text>
          <Tooltip label="Deselect all" {...tooltipProps}>
            <ActionIcon onClick={resetState} {...actionIconProps}>
              <IconSquareOff {...iconProps} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label="Report CSAM" {...tooltipProps}>
            <ActionIcon
              onClick={handleReportCsam}
              color="orange"
              loading={reportCsam.isLoading}
              {...actionIconProps}
            >
              <IconAlertTriangle {...iconProps} />
            </ActionIcon>
          </Tooltip>
        </>
      )}
    </Paper>
  );
}

export default Page(FlaggedConsumerId, { features: (features) => features.csamReports });
