import {
  ActionIcon,
  Alert,
  Badge,
  Card,
  createStyles,
  Loader,
  RingProgress,
  RingProgressProps,
  Text,
  Tooltip,
  TooltipProps,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import {
  IconAlertTriangleFilled,
  IconArrowsShuffle,
  IconBan,
  IconCheck,
  IconInfoHexagon,
  IconTrash,
} from '@tabler/icons-react';

import { Currency } from '~/shared/utils/prisma/enums';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Collection } from '~/components/Collection/Collection';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
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

import { generationPanel, generationStore } from '~/store/generation.store';
import { formatDateMin } from '~/utils/date-helpers';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import {
  NormalizedGeneratedImageResponse,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import { TimeSpan, WorkflowStatus } from '@civitai/client';
import { orchestratorPendingStatuses } from '~/shared/constants/generation.constants';
import { trpc } from '~/utils/trpc';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TwCard } from '~/components/TwCard/TwCard';
import { GenerationResource } from '~/server/services/generation/generation.service';

const PENDING_PROCESSING_STATUSES: WorkflowStatus[] = [
  ...orchestratorPendingStatuses,
  'processing',
];
const LONG_DELAY_TIME = 5; // minutes
const EXPIRY_TIME = 10; // minutes
const delayTimeouts = new Map<string, NodeJS.Timeout>();

export function QueueItem({
  request,
  step,
  id,
  filter,
}: {
  request: NormalizedGeneratedImageResponse;
  step: NormalizedGeneratedImageStep;
  id: string;
  filter: { marker?: string } | undefined;
}) {
  const { classes, cx } = useStyle();
  const features = useFeatureFlags();
  const [ref, inView] = useInViewDynamic({ id });

  const generationStatus = useGenerationStatus();
  const { unstableResources } = useUnstableResources();

  const { copied, copy } = useClipboard();

  const [showDelayedMessage, setShowDelayedMessage] = useState(false);
  const { status } = request;
  const { params, resources = [] } = step;

  let { images } = step;
  const failureReason = images.find((x) => x.status === 'failed' && x.reason)?.reason;

  if (filter && filter.marker) {
    images = images.filter((image) => {
      const isFavorite = step.metadata?.images?.[image.id]?.favorite === true;
      const feedback = step.metadata?.images?.[image.id]?.feedback;

      if (filter.marker === 'favorited') return isFavorite;
      else if (filter.marker === 'liked' || filter.marker === 'disliked')
        return feedback === filter.marker;
    });
  }

  const cost = request.totalCost;
  const processing = status === 'processing';
  const pending = orchestratorPendingStatuses.includes(status);

  const cancellable = PENDING_PROCESSING_STATUSES.includes(status);

  useEffect(() => {
    if (!cancellable) return;

    const id = request.id.toString();

    function removeTimeout(id: string) {
      const timeout = delayTimeouts.get(id);
      if (timeout) {
        clearTimeout(timeout);
        delayTimeouts.delete(id);
      }
    }

    removeTimeout(id);
    delayTimeouts.set(
      id,
      setTimeout(() => {
        setShowDelayedMessage(true);
        delayTimeouts.delete(id);
      }, LONG_DELAY_TIME * 60 * 1000)
    );
    return () => {
      removeTimeout(id);
    };
  }, [request.id, request.createdAt, cancellable]);

  const refundTime = dayjs(request.createdAt)
    .add(step.timeout ? new TimeSpan(step.timeout).minutes : EXPIRY_TIME, 'minute')
    .toDate();

  const handleCopy = () => {
    copy(images.map((x) => x.jobId).join('\n'));
  };

  const handleGenerate = () => {
    generationStore.setData({
      resources: step.resources ?? [],
      params: { ...(step.params as any), seed: undefined },
      remixOfId: step.metadata?.remixOfId,
      type: images[0].type, // TODO - type based off type of media
      workflow: step.params.workflow,
      sourceImage: (step.params as any).sourceImage,
      engine: (step.params as any).engine,
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

  const actualCost = cost;

  const completedCount = images.filter((x) => x.status === 'succeeded').length;
  const processingCount = images.filter((x) => x.status === 'processing').length;

  const canRemix = step.params.workflow !== 'img2img-upscale';

  const { data: workflowDefinitions } = trpc.generation.getWorkflowDefinitions.useQuery();
  const workflowDefinition = workflowDefinitions?.find((x) => x.key === params.workflow);

  const engine =
    step.metadata.params && 'engine' in step.metadata.params
      ? (step.metadata.params.engine as string)
      : undefined;

  const queuePosition = images[0]?.queuePosition;

  return (
    <Card ref={ref} withBorder px="xs" id={id}>
      {inView && (
        <Card.Section py={4} inheritPadding withBorder>
          <div className="flex justify-between">
            <div className="flex flex-wrap items-center gap-1">
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
                    readOnly
                    variant="badge"
                  />
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
              <CancelOrDeleteWorkflow workflowId={request.id} cancellable={cancellable} />
            </div>
          </div>
        </Card.Section>
      )}

      {inView && (
        <>
          <div className="flex flex-col gap-3 py-3 @container">
            {showDelayedMessage && cancellable && request.steps[0]?.$type !== 'videoGen' && (
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
              {engine && (
                <Badge radius="sm" color="violet" size="sm">
                  {engine}
                </Badge>
              )}
            </div>
            <Collection items={resources} limit={3} renderItem={ResourceBadge} grouped />
            {failureReason && <Alert color="red">{failureReason}</Alert>}

            <div
              className={cx(classes.grid, {
                [classes.asSidebar]: !features.largerGenerationImages,
              })}
            >
              {images.map((image) => (
                <GeneratedImage
                  key={`${image.id}_${image.jobId}`}
                  image={image}
                  request={request}
                  step={step}
                />
              ))}

              {(pending || processing) && (
                <TwCard
                  className="items-center justify-center border"
                  style={{
                    aspectRatio: images[0].aspectRatio ?? images[0].width / images[0].height,
                  }}
                >
                  {processing && (
                    <>
                      {images[0].type === 'video' &&
                      images[0].progress &&
                      images[0].progress < 1 ? (
                        <ProgressIndicator progress={images[0].progress} />
                      ) : (
                        <>
                          <Loader size={24} />
                          <Text color="dimmed" size="xs" align="center">
                            Generating
                          </Text>
                        </>
                      )}
                    </>
                  )}
                  {pending &&
                    (queuePosition ? (
                      <>
                        {queuePosition.support === 'unavailable' && (
                          <Text color="dimmed" size="xs" align="center">
                            Currently unavailable
                          </Text>
                        )}
                        {!!queuePosition.precedingJobs && (
                          <Text color="dimmed" size="xs" align="center">
                            Your position in queue: {queuePosition.precedingJobs}
                          </Text>
                        )}
                        {queuePosition.startAt && (
                          <Text size="xs" color="dimmed">
                            Estimated start time: {formatDateMin(new Date(queuePosition.startAt))}
                          </Text>
                        )}
                      </>
                    ) : (
                      <Text color="dimmed" size="xs" align="center">
                        Pending
                      </Text>
                    ))}
                </TwCard>
              )}
            </div>
          </div>
        </>
      )}

      {inView && (
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
      )}
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
    gridTemplateColumns: 'repeat(1, 1fr)', // default for larger screens, max 6 columns

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

const ResourceBadge = (props: GenerationResource) => {
  const { unstableResources } = useUnstableResources();

  const { model, id, name } = props;
  const unstable = unstableResources?.includes(id);

  const badge = (
    <Badge
      size="sm"
      color={unstable ? 'yellow' : undefined}
      sx={{ maxWidth: 200, cursor: 'pointer' }}
      component={Link}
      href={`/models/${model.id}?modelVersionId=${id}`}
      onClick={() => generationPanel.close()}
    >
      {model.name} - {name}
    </Badge>
  );

  return unstable ? <Tooltip label="Unstable resource">{badge}</Tooltip> : badge;
};

const ProgressIndicator = ({
  progress,
  ...ringProgressProps
}: Omit<RingProgressProps, 'sections'> & { progress: number }) => {
  const color = progress >= 1 ? 'green' : 'blue';
  const value = progress * 100;

  return (
    <RingProgress
      {...ringProgressProps}
      size={100}
      thickness={8}
      sections={[{ value, color }]}
      label={
        <Text color="blue" weight={700} align="center">
          {value.toFixed(0)}%
        </Text>
      }
    />
  );
};

const tooltipProps: Omit<TooltipProps, 'children' | 'label'> = {
  withinPortal: true,
  withArrow: true,
  color: 'dark',
  zIndex: constants.imageGeneration.drawerZIndex + 1,
};

function CancelOrDeleteWorkflow({
  workflowId,
  cancellable,
}: {
  workflowId: string;
  cancellable: boolean;
}) {
  // use `cancelling` state so that users don't try to cancel a workflow multiple times
  const [cancelling, setCancelling] = useState(false);
  const deleteMutation = useDeleteTextToImageRequest();
  const cancelMutation = useCancelTextToImageRequest();
  const cancellingDeleting = deleteMutation.isLoading || cancelMutation.isLoading || cancelling;

  const handleDeleteQueueItem = () => {
    deleteMutation.mutate({ workflowId });
  };

  const handleCancel = () => {
    cancelMutation.mutateAsync({ workflowId }).then(() => {
      setCancelling(true);
    });
  };

  useEffect(() => {
    if (!cancellable) {
      setCancelling(false);
    }
  }, [cancellable]);

  return (
    <PopConfirm
      message={cancellable ? 'Attempt to cancel?' : 'Are you sure?'}
      position="bottom-end"
      onConfirm={cancellable ? handleCancel : handleDeleteQueueItem}
      disabled={cancellingDeleting}
    >
      <ButtonTooltip {...tooltipProps} label={cancellable ? 'Cancel' : 'Delete'}>
        <ActionIcon size="md" disabled={cancellingDeleting} color="red">
          {cancellable ? <IconBan size={20} /> : <IconTrash size={20} />}
        </ActionIcon>
      </ButtonTooltip>
    </PopConfirm>
  );
}
