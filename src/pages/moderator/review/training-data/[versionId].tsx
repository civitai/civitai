import { Button, Loader, Popover, Text, ActionIcon } from '@mantine/core';
import { IconInfoSquareRounded, IconExternalLink } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useRef, useState } from 'react';
import { Page } from '~/components/AppLayout/Page';
import { CsamDetailsForm } from '~/components/Csam/CsamDetailsForm';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useStepper } from '~/hooks/useStepper';
import { fetchBlob } from '~/utils/file-utils';
import { getJSZip } from '~/utils/lazy';
import { unzipTrainingData } from '~/utils/training';
import { trpc } from '~/utils/trpc';
import { NextLink } from '~/components/NextLink/NextLink';

function ReviewTrainingData() {
  const router = useRouter();
  const versionId = Number(router.query.versionId);
  const requestedRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [urls, setUrls] = useState<string[]>([]);
  const [error, setError] = useState<Error>();
  const [currentStep, actions] = useStepper(2);
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.modelVersion.getTrainingDetails.useQuery({
    id: versionId,
  });

  const user = data?.user;
  const workflowId = data?.workflowId;

  useEffect(() => {
    if (requestedRef.current || urls.length > 0) return;
    requestedRef.current = true;
    setLoading(true);
    fetchBlob(`/api/download/training-data/${versionId}`)
      .then(async (zip) => {
        if (zip) {
          const zipReader = await getJSZip();
          const zData = await zipReader.loadAsync(zip);
          const urls = await unzipTrainingData(zData, ({ imgBlob }) =>
            URL.createObjectURL(imgBlob)
          );
          setUrls(urls);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(err);
        setLoading(false);
      });
  }, []);

  function handleSuccess() {
    utils.moderator.modelVersions.query.invalidate({ trainingStatus: 'Paused' }, { exact: false });
    router.back();
  }

  const details: DescriptionTableProps['items'] = [
    {
      label: 'Workflow ID',
      value: data?.workflowId ?? 'N/A',
    },
    {
      label: 'JobID',
      value: data?.jobId,
      visible: !data?.workflowId,
    },
    {
      label: 'Version',
      value: data?.trainingResults?.version ?? '1',
    },
    {
      label: 'Started At',
      value: data?.trainingResults?.startedAt ?? 'N/A',
    },
    {
      label: 'Submitted At',
      value: data?.trainingResults?.submittedAt ?? 'N/A',
    },
    {
      label: 'Completed At',
      value: data?.trainingResults?.completedAt ?? 'N/A',
    },
  ];

  useEffect(() => console.log({ currentStep }), [currentStep]);

  return loading || isLoading ? (
    <div className="p-3">
      <Loader className="mx-auto" />
    </div>
  ) : !user ? (
    <div className="p-3">
      <Text align="center">Failed to load user</Text>
    </div>
  ) : error ? (
    <div className="p-3">
      <pre className="mx-auto">{JSON.stringify(error.message)}</pre>
    </div>
  ) : (
    <>
      <div className="container flex max-w-lg justify-end gap-3 p-3">
        <ActionIcon
          component={NextLink}
          href={`/models/${data?.modelId}?modelVersionId=${versionId}`}
          target="_blank"
        >
          <IconExternalLink />
        </ActionIcon>
        <Popover width={300} withArrow withinPortal shadow="sm">
          <Popover.Target>
            <ActionIcon>
              <IconInfoSquareRounded />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <DescriptionTable items={details} />
          </Popover.Dropdown>
        </Popover>
      </div>
      {currentStep === 1 && (
        <ReviewImages
          onNext={actions.goToNextStep}
          urls={urls}
          versionId={versionId}
          onModerate={handleSuccess}
        />
      )}
      {currentStep !== 1 && (
        <CsamDetailsForm
          onPrevious={actions.goToPrevStep}
          onSuccess={handleSuccess}
          userId={user.id}
          type="TrainingData"
          defaultValues={{ modelVersionIds: [versionId] }}
        />
      )}
    </>
  );
}

export default Page(ReviewTrainingData, {
  scrollable: false,
  features: (features) => !!features.reviewTrainingData,
});

// export default createPage(ReviewTrainingData, {
//   withScrollArea: false,
//   features: (features) => !!features.reviewTrainingData,
// });

function ReviewImages({
  onNext,
  urls,
  versionId,
  onModerate: onSuccess,
}: {
  onNext: () => void;
  urls: string[];
  versionId: number;
  onModerate: () => void;
}) {
  const approve = trpc.moderator.trainingData.approve.useMutation({ onSuccess });
  const deny = trpc.moderator.trainingData.deny.useMutation({ onSuccess });
  const disabled = approve.isLoading || deny.isLoading;

  function handleApprove() {
    approve.mutate({ id: versionId });
  }

  function handleDeny() {
    deny.mutate({ id: versionId });
  }

  function handleReportCsam() {
    onNext();
  }

  return (
    <div className="flex size-full flex-col">
      <div className="container flex max-w-lg justify-end gap-3 p-3">
        <Button disabled={disabled} onClick={handleApprove}>
          Approve
        </Button>
        <Button disabled={disabled} onClick={handleDeny} color="yellow">
          Deny
        </Button>
        <Button disabled={disabled} onClick={handleReportCsam} color="red">
          Report CSAM
        </Button>
      </div>
      <ScrollArea className="size-auto pt-0">
        <div className="container max-w-lg">
          <div className="grid grid-cols-4 gap-4">
            {urls.map((url, index) => (
              <div key={index} className="flex items-center justify-center card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="max-w-full" loading="lazy" />
              </div>
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
