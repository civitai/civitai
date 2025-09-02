import { useRouter } from 'next/router';
import { trpc } from '~/utils/trpc';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, Chip, Card, Badge } from '@mantine/core';
import { NoContent } from '~/components/NoContent/NoContent';
import { NextLink } from '~/components/NextLink/NextLink';
import type { ConsumerStrike } from '~/server/http/orchestrator/flagged-consumers';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Tabs } from '@mantine/core';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { create } from 'zustand';

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
      {user?.username && (
        <h1 className="mb-3 text-2xl font-bold">
          Username: <NextLink href={`/user/${user.username}`}>{user.username}</NextLink>
        </h1>
      )}
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
  const [selectedReasons, setSelectedReasons] = useState<string[]>(reasons);
  const items = useMemo(
    () => data.filter((x) => x.job && selectedReasons.includes(x.strike.reason)),
    [data, selectedReasons]
  );

  return (
    <>
      <div className="flex justify-between">
        <div className="flex gap-1">
          <Chip.Group value={selectedReasons} onChange={setSelectedReasons} multiple>
            {reasons.map((reason) => (
              <Chip key={reason} value={reason}>
                {reason}
              </Chip>
            ))}
          </Chip.Group>
        </div>
        <SelectedCount />
      </div>
      <div className="flex flex-col gap-3">
        {items.slice(0, 100).map(({ strike, job }, index) => (
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
  return count > 0 ? <span>{count} selected</span> : null;
}
