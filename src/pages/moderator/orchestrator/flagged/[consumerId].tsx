import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TooltipProps } from '@mantine/core';
import { Text, Chip, Card, Badge, Pagination, Select, ActionIcon, Tooltip } from '@mantine/core';
import { NoContent } from '~/components/NoContent/NoContent';
import { NextLink } from '~/components/NextLink/NextLink';
import type { ConsumerStrike } from '~/server/http/orchestrator/flagged-consumers';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Tabs } from '@mantine/core';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { create } from 'zustand';
import { useLocalStorage } from '@mantine/hooks';
import { IconCheck, IconSquareOff } from '@tabler/icons-react';

const useStore = create<Record<string, boolean>>(() => ({}));
const resetState = () => {
  console.log('resetting');
  useStore.setState({}, true);
};

export default function FlaggedConsumerId() {
  const router = useRouter();
  const consumerId = router.query.consumerId as string;
  const userId = Number(consumerId.split('-')[1]);

  const { data: user } = trpc.user.getById.useQuery({ id: userId });

  useEffect(() => resetState, []);

  return (
    <div className="container max-w-md">
      <div className="flex justify-between">
        <h1 className="mb-3 text-2xl font-bold">
          Username:{' '}
          {user?.username && <NextLink href={`/user/${user.username}`}>{user.username}</NextLink>}
        </h1>
        <SelectedCount />
      </div>
      <FlaggedConsumerContent consumerId={consumerId} />
    </div>
  );
}

function FlaggedConsumerContent({ consumerId }: { consumerId: string }) {
  const [status, setStatus] = useState<string | null>(null);

  const { data, isLoading } = trpc.orchestrator.getFlaggedConsumerStrikes.useQuery({ consumerId });

  if (isLoading) return <PageLoader />;
  if (!data) return <NoContent />;

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
  const [activePage, setPage] = useState(0);
  const [pageSize, setPageSize] = useLocalStorage({ key: 'page-size', defaultValue: 100 });
  const [selectedReasons, setSelectedReasons] = useState<string[]>(reasons);
  const filtered = useMemo(
    () => data.filter((x) => x.job && selectedReasons.includes(x.strike.reason)),
    [data, selectedReasons]
  );
  const totalPages = Math.ceil(filtered.length / pageSize);
  const _activePage = totalPages < activePage ? totalPages : activePage;

  const items = useMemo(() => {
    return filtered.slice(_activePage, pageSize);
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
        {items.map(({ strike, job }, index) => (
          <Card key={index} withBorder padding="sm">
            <div className="mb-1 grid grid-cols-4 gap-1">
              {job.blobs.map((blob, i) => (
                <ConsumerStrikePreviewImage key={i} {...blob} />
              ))}
            </div>
            <Text size="sm">
              <Badge component="span" size="sm">
                {strike.reason}
              </Badge>{' '}
              {job.prompt}
            </Text>
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
      onClick={toggleSelect}
      style={{ aspectRatio: 1, borderColor: active ? 'blue' : undefined }}
    >
      {/* <EdgeMedia2
                  key={i}
                  src={previewUrl}
                  type={id.includes('.mp4') ? 'video' : 'image'}
                  disableWebm
                  disablePoster
                  muted
                  loading="lazy"
                /> */}
    </Card>
  );
}

function SelectedCount() {
  const count = useStore((state) => Object.values(state).filter(Boolean).length);

  if (!count) return null;

  const tooltipProps: Omit<TooltipProps, 'label' | 'children'> = {
    position: 'bottom',
    withArrow: true,
    withinPortal: true,
    variant: 'filled',
  };

  const iconProps = {
    size: '1.25rem',
  };

  function handleReview() {
    console.log('mark as reviewed');
  }

  function handleReportCsam() {
    console.log('report CSAM');
  }

  return (
    <Card
      padding={0}
      withBorder
      className="flex flex-row items-center gap-1 p-3"
      style={{ position: 'sticky', top: 'var(--header-height,0)' }}
    >
      <Text size="sm">{count} Selected</Text>
      <Tooltip label="Deselect all" {...tooltipProps}>
        <ActionIcon onClick={resetState}>
          <IconSquareOff {...iconProps} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Mark as reviewed" {...tooltipProps}>
        <ActionIcon onClick={handleReview} color="green">
          <IconCheck {...iconProps} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Report CSAM" {...tooltipProps}>
        <ActionIcon onClick={handleReportCsam} color="orange">
          <IconSquareOff {...iconProps} />
        </ActionIcon>
      </Tooltip>
    </Card>
  );
}
