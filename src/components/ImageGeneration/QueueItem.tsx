import {
  ActionIcon,
  Alert,
  Badge,
  Card,
  createStyles,
  MantineColor,
  Text,
  Tooltip,
  TooltipProps,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import {
  IconAlertTriangleFilled,
  IconArrowsShuffle,
  IconBan,
  IconCheck,
  IconInfoHexagon,
  IconTrash,
} from '@tabler/icons-react';

import { Currency } from '@prisma/client';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { Collection } from '~/components/Collection/Collection';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { GeneratedImage, GenerationPlaceholder } from '~/components/ImageGeneration/GeneratedImage';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import {
  useGenerationStatus,
  useUnstableResources,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { GenerationStatusBadge } from '~/components/ImageGeneration/GenerationStatusBadge';
import {
  useCancelTextToImageRequest,
  useDeleteTextToImageRequest,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { constants } from '~/server/common/constants';
import { Generation } from '~/server/services/generation/generation.types';
import { generationPanel, generationStore, useGenerationStore } from '~/store/generation.store';
import { formatDateMin } from '~/utils/date-helpers';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import {
  NormalizedGeneratedImageResponse,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import { WorkflowStatus } from '@civitai/client';
import {
  orchestratorPendingStatuses,
  orchestratorRefundableStatuses,
} from '~/shared/constants/generation.constants';
import { trpc } from '~/utils/trpc';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useRouter } from 'next/router';

// const FAILED_STATUSES: WorkflowStatus[] = ['failed', 'expired'];
// const PENDING_STATUSES = [GenerationRequestStatus.Pending, GenerationRequestStatus.Processing];
const PENDING_PROCESSING_STATUSES: WorkflowStatus[] = [
  ...orchestratorPendingStatuses,
  'processing',
];
const LONG_DELAY_TIME = 5; // minutes
const EXPIRY_TIME = 10; // minutes
const delayTimeouts = new Map<string, NodeJS.Timeout>();

// export function QueueItem({ data: request, index }: { data: Generation.Request; index: number }) {
export function QueueItem({
  request,
  step,
  id,
}: {
  request: NormalizedGeneratedImageResponse;
  step: NormalizedGeneratedImageStep;
  id: string;
}) {
  const { classes } = useStyle();
  const features = useFeatureFlags();
  const { pathname } = useRouter();

  const generationStatus = useGenerationStatus();
  const view = useGenerationStore((state) => state.view);
  const { unstableResources } = useUnstableResources();

  const { copied, copy } = useClipboard();

  const [showDelayedMessage, setShowDelayedMessage] = useState(false);
  const { status } = request;
  const { params, images, resources } = step;
  const cost = request.totalCost;

  const pendingProcessing = status && PENDING_PROCESSING_STATUSES.includes(status);
  const [processing, setProcessing] = useState(status === 'processing');
  useEffect(() => {
    if (!processing && status === 'processing') setProcessing(true);
    else if (!PENDING_PROCESSING_STATUSES.includes(status)) setProcessing(false);
  }, [status]);

  const deleteMutation = useDeleteTextToImageRequest();
  const cancelMutation = useCancelTextToImageRequest();
  const cancellingDeleting = deleteMutation.isLoading || cancelMutation.isLoading;

  useEffect(() => {
    if (!pendingProcessing) return;
    const id = request.id.toString();
    if (delayTimeouts.has(id)) clearTimeout(delayTimeouts.get(id)!);
    delayTimeouts.set(
      id,
      setTimeout(() => {
        setShowDelayedMessage(true);
        delayTimeouts.delete(id);
      }, LONG_DELAY_TIME * 60 * 1000)
    );
    return () => {
      if (delayTimeouts.has(id)) clearTimeout(delayTimeouts.get(id)!);
    };
  }, [request.id, request.createdAt, pendingProcessing]);
  const refundTime = dayjs(request.createdAt).add(EXPIRY_TIME, 'minute').toDate();

  const handleDeleteQueueItem = () => {
    deleteMutation.mutate({ workflowId: request.id });
  };

  const handleCancel = () => cancelMutation.mutate({ workflowId: request.id });

  const handleCopy = () => {
    copy(images.map((x) => x.jobId).join('\n'));
  };

  const handleGenerate = () => {
    generationStore.setData({
      resources: step.resources,
      params: { ...step.params, seed: undefined },
      view: !pathname.includes('generate') ? 'generate' : view,
    });
  };

  const { prompt, ...details } = params;

  const hasUnstableResources = resources.some((x) => unstableResources.includes(x.id));
  const overwriteStatusLabel =
    hasUnstableResources && status === 'failed'
      ? `${status} - Potentially caused by unstable resources`
      : status === 'failed'
      ? `${status} - Generations can error for any number of reasons, try regenerating or swapping what models/additional resources you're using.`
      : status;

  // const refunded = Math.ceil(
  //   !!cost
  //     ? (cost / params.quantity) *
  //         (params.quantity -
  //           (images.filter((x) => !orchestratorRefundableStatuses.includes(x.status)).length ?? 0))
  //     : 0
  // );
  // const actualCost = !!cost ? cost - refunded : 0;
  const actualCost = cost;

  const completedCount = images.filter((x) => x.status === 'succeeded').length;
  const processingCount = images.filter((x) => x.status === 'processing').length;

  const canRemix = step.params.workflow !== 'img2img-upscale';

  const { data: workflowDefinitions } = trpc.generation.getWorkflowDefinitions.useQuery();
  const workflowDefinition = workflowDefinitions?.find((x) => x.key === params.workflow);

  return (
    <Card withBorder px="xs" id={id}>
      <Card.Section py={4} inheritPadding withBorder>
        <div className="flex justify-between">
          <div className="flex items-center gap-1">
            {!!images.length && (
              <GenerationStatusBadge
                status={request.status}
                complete={completedCount}
                processing={processingCount}
                quantity={images.length}
                tooltipLabel={overwriteStatusLabel}
                progress
              />
            )}

            <Text size="xs" color="dimmed">
              {formatDateMin(request.createdAt)}
            </Text>
            {!!actualCost &&
              dayjs(request.createdAt).toDate() >=
                constants.buzz.generationBuzzChargingStartDate && (
                <GenerationCostPopover
                  workflowCost={request.cost ?? {}}
                  disabled={!features.creatorComp}
                  readOnly
                >
                  {/* Wrapped in div for the popover to work properly */}
                  <div className="cursor-pointer">
                    <CurrencyBadge unitAmount={actualCost} currency={Currency.BUZZ} size="xs" />
                  </div>
                </GenerationCostPopover>
              )}
          </div>
          <div className="flex gap-1">
            <ButtonTooltip {...tooltipProps} label="Copy Job IDs">
              <ActionIcon size="md" p={4} radius={0} onClick={handleCopy}>
                {copied ? <IconCheck /> : <IconInfoHexagon />}
              </ActionIcon>
            </ButtonTooltip>
            {generationStatus.available && canRemix && (
              <ButtonTooltip {...tooltipProps} label="Remix">
                <ActionIcon size="md" p={4} radius={0} onClick={handleGenerate}>
                  <IconArrowsShuffle />
                </ActionIcon>
              </ButtonTooltip>
            )}
            <PopConfirm
              message={`Are you sure you want to ${
                pendingProcessing ? 'cancel' : 'delete'
              } this job?`}
              position="bottom-end"
              onConfirm={pendingProcessing ? handleCancel : handleDeleteQueueItem}
            >
              <ButtonTooltip
                {...tooltipProps}
                label={pendingProcessing ? 'Cancel job' : 'Delete job'}
              >
                <ActionIcon size="md" disabled={cancellingDeleting} color="red">
                  {pendingProcessing ? <IconBan size={20} /> : <IconTrash size={20} />}
                </ActionIcon>
              </ButtonTooltip>
            </PopConfirm>
          </div>
        </div>
      </Card.Section>
      <div className="flex flex-col gap-3 py-3 @container">
        {showDelayedMessage && pendingProcessing && (
          <Alert color="yellow" p={0}>
            <div className="flex items-center gap-2 px-2 py-1">
              <Text size="xs" color="yellow" lh={1}>
                <IconAlertTriangleFilled size={20} />
              </Text>
              <Text size="xs" lh={1.2} color="yellow">
                <Text weight={500} component="span">
                  This is taking longer than usual.
                </Text>
                {` Don't want to wait? Cancel this job to get refunded for any undelivered images. If we aren't done by ${formatDateMin(
                  refundTime
                )} we'll refund you automatically.`}
              </Text>
            </div>
          </Alert>
        )}

        <ContentClamp maxHeight={36} labelSize="xs">
          <Text lh={1.3} sx={{ wordBreak: 'break-all' }}>
            {prompt}
          </Text>
        </ContentClamp>

        <div className="-my-2">
          {workflowDefinition && (
            <Badge radius="sm" color="violet" size="sm">
              {workflowDefinition.label}
            </Badge>
          )}
        </div>
        <Collection items={resources} limit={3} renderItem={ResourceBadge} grouped />
        {(!!images?.length || processing) && (
          <div className={classes.grid}>
            {images.map((image) => (
              <GeneratedImage key={image.id} image={image} request={request} step={step} />
            ))}
            {processing && <GenerationPlaceholder width={params.width} height={params.height} />}
          </div>
        )}
      </div>
      <Card.Section
        withBorder
        sx={(theme) => ({
          marginLeft: -theme.spacing.xs,
          marginRight: -theme.spacing.xs,
        })}
      >
        <GenerationDetails
          label="Additional Details"
          params={details}
          labelWidth={150}
          paperProps={{ radius: 0, sx: { borderWidth: '1px 0 0 0' } }}
        />
      </Card.Section>
    </Card>
  );
}

const useStyle = createStyles((theme) => ({
  stopped: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[1],
  },
  grid: {
    display: 'grid',
    gap: theme.spacing.xs,
    gridTemplateColumns: 'repeat(2, 1fr)', // default for larger screens, max 6 columns

    // [`@media (max-width: ${theme.breakpoints.xl}px)`]: {
    //   gridTemplateColumns: 'repeat(4, 1fr)', // 4 columns for screens smaller than xl
    // },
    [`@container (min-width: 530px)`]: {
      gridTemplateColumns: 'repeat(3, 1fr)', // 3 columns for screens smaller than md
    },
    [`@container (min-width: 900px)`]: {
      gridTemplateColumns: 'repeat(4, 1fr)', // 5 columns for screens smaller than xl
    },
    [`@container (min-width: 1200px)`]: {
      gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))',
    },
  },
  asSidebar: {
    gridTemplateColumns: 'repeat(2, 1fr)',
  },
}));

const ResourceBadge = (props: Generation.Resource) => {
  const { unstableResources } = useUnstableResources();

  const { modelId, modelName, id, name } = props;
  const unstable = unstableResources?.includes(id);

  const badge = (
    <Badge
      size="sm"
      color={unstable ? 'yellow' : undefined}
      sx={{ maxWidth: 200, cursor: 'pointer' }}
      component={NextLink}
      href={`/models/${modelId}?modelVersionId=${id}`}
      onClick={() => generationPanel.close()}
    >
      {modelName} - {name}
    </Badge>
  );

  return unstable ? <Tooltip label="Unstable resource">{badge}</Tooltip> : badge;
};

const tooltipProps: Omit<TooltipProps, 'children' | 'label'> = {
  withinPortal: true,
  withArrow: true,
  color: 'dark',
  zIndex: constants.imageGeneration.drawerZIndex + 1,
};
