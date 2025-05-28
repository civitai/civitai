import {
  ActionIcon,
  Alert,
  Badge,
  Card,
  Group,
  Loader,
  RingProgress,
  RingProgressProps,
  Text,
  Tooltip,
  TooltipProps,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import {
  IconAlertTriangleFilled,
  IconArrowsShuffle,
  IconBan,
  IconCheck,
  IconFlagQuestion,
  IconInfoHexagon,
  IconTrash,
} from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';

import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Collection } from '~/components/Collection/Collection';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
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

import { TimeSpan, WorkflowStatus } from '@civitai/client';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { TwCard } from '~/components/TwCard/TwCard';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { GenerationResource } from '~/server/services/generation/generation.service';
import {
  NormalizedGeneratedImageResponse,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import { orchestratorPendingStatuses } from '~/shared/constants/generation.constants';
import { generationPanel, generationStore } from '~/store/generation.store';
import { formatDateMin } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { TransactionsPopover } from '~/components/ImageGeneration/GenerationForm/TransactionsPopover';
import classes from './QueueItem.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

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
  const currentUser = useCurrentUser();
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
      resources: (step.resources as any) ?? [],
      params: { ...(step.params as any), seed: null },
      remixOfId: step.metadata?.remixOfId,
      type: images[0].type, // TODO - type based off type of media
      workflow: step.params.workflow,
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

  const completedCount = images.filter((x) => x.status === 'succeeded').length;
  const processingCount = images.filter((x) => x.status === 'processing').length;

  const canRemix =
    (step.params.workflow &&
      !['img2img-upscale', 'img2img-background-removal'].includes(step.params.workflow)) ||
    !!(step.params as any).engine;

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

              <Text size="xs" c="dimmed">
                {formatDateMin(request.createdAt)}
              </Text>
              {!!request.cost?.total && (
                <GenerationCostPopover workflowCost={request.cost} readOnly variant="badge" />
              )}
              {request.transactions.length > 0 && (
                <TransactionsPopover data={request.transactions} />
              )}
              {!!request.duration && currentUser?.isModerator && (
                <Badge color="yellow">Duration: {request.duration}</Badge>
              )}
            </div>
            <div className="flex gap-1">
              <SubmitBlockedImagesForReviewButton step={step} />
              <ButtonTooltip {...tooltipProps} label="Copy Job IDs">
                <LegacyActionIcon size="md" p={4} radius={0} onClick={handleCopy}>
                  {copied ? <IconCheck /> : <IconInfoHexagon />}
                </LegacyActionIcon>
              </ButtonTooltip>
              {generationStatus.available && canRemix && (
                <ButtonTooltip {...tooltipProps} label="Remix">
                  <LegacyActionIcon size="md" p={4} radius={0} onClick={handleGenerate}>
                    <IconArrowsShuffle />
                  </LegacyActionIcon>
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
                    <Text fw={500} component="span">
                      This is taking longer than usual.
                    </Text>
                    {` Don't want to wait? Cancel this job to get refunded for any undelivered images. If we aren't done by ${formatDateMin(
                      refundTime
                    )} we'll refund you automatically.`}
                  </Text>
                </div>
              </Alert>
            )}

            {prompt && (
              <ContentClamp maxHeight={36} labelSize="xs">
                <Text lh={1.3} style={{ wordBreak: 'break-all' }}>
                  {prompt}
                </Text>
              </ContentClamp>
            )}

            <div className="-my-2 flex gap-2">
              {workflowDefinition && (
                <Badge radius="sm" color="violet" size="sm" classNames={{ label: 'overflow-hidden' }}>
                  {workflowDefinition.label}
                </Badge>
              )}
              {engine && (
                <Badge radius="sm" color="violet" size="sm" classNames={{ label: 'overflow-hidden' }}>
                  {engine}
                </Badge>
              )}
            </div>
            <Collection items={resources} limit={3} renderItem={ResourceBadge} grouped />
            {failureReason && <Alert color="red">{failureReason}</Alert>}

            <div
              className={clsx(classes.grid, {
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
                          <Text c="dimmed" size="xs" align="center">
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
                          <Text c="dimmed" size="xs" align="center">
                            Currently unavailable
                          </Text>
                        )}
                        {!!queuePosition.precedingJobs && (
                          <Text c="dimmed" size="xs" align="center">
                            Your position in queue: {queuePosition.precedingJobs}
                          </Text>
                        )}
                        {queuePosition.startAt && (
                          <Text size="xs" c="dimmed">
                            Estimated start time: {formatDateMin(new Date(queuePosition.startAt))}
                          </Text>
                        )}
                      </>
                    ) : (
                      <Text c="dimmed" size="xs" align="center">
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
        <Card.Section withBorder className="-mx-2">
          <GenerationDetails
            label="Additional Details"
            params={details}
            labelWidth={150}
            paperProps={{ radius: 0, style: { borderWidth: '1px 0 0 0' } }}
          />
        </Card.Section>
      )}
    </Card>
  );
}

const ResourceBadge = (props: GenerationResource) => {
  const { unstableResources } = useUnstableResources();

  const { model, id, name, epochDetails } = props;
  const unstable = unstableResources?.includes(id);
  const hasEpochDetails = !!epochDetails?.epochNumber;

  const badge = (
    <Group gap={4} wrap="nowrap">
      <Badge
        size="sm"
        color={unstable ? 'yellow' : undefined}
        style={{
          maxWidth: 200,
          cursor: 'pointer',
          borderTopRightRadius: hasEpochDetails ? 0 : undefined,
          borderBottomRightRadius: hasEpochDetails ? 0 : undefined,
        }}
        classNames={{ label: '!overflow-hidden' }}
        component={Link}
        href={`/models/${model.id}?modelVersionId=${id}`}
        onClick={() => generationPanel.close()}
      >
        {model.name} - {name}
      </Badge>
      {epochDetails?.epochNumber && (
        <Tooltip label={`Epoch: #${epochDetails?.epochNumber}`}>
          <Badge
            size="sm"
            color={unstable ? 'yellow' : undefined}
            style={{
              borderTopLeftRadius: hasEpochDetails ? 0 : undefined,
              borderBottomLeftRadius: hasEpochDetails ? 0 : undefined,
            }}
            classNames={{ label: '!overflow-hidden' }}
          >
            #{epochDetails?.epochNumber}
          </Badge>
        </Tooltip>
      )}
    </Group>
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
        <Text c="blue" fw={700} align="center">
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
        <LegacyActionIcon size="md" disabled={cancellingDeleting} color="red">
          {cancellable ? <IconBan size={20} /> : <IconTrash size={20} />}
        </LegacyActionIcon>
      </ButtonTooltip>
    </PopConfirm>
  );
}

function SubmitBlockedImagesForReviewButton({ step }: { step: NormalizedGeneratedImageStep }) {
  const blockedImages = step.images.filter((x) => !!x.blockedReason);
  const currentUser = useCurrentUser();
  if (!blockedImages.length || !currentUser?.username) return null;

  return (
    <ButtonTooltip {...tooltipProps} label="Submit blocked images for review">
      <LegacyActionIcon
        component="a"
        target="_blank"
        size="md"
        p={4}
        radius={0}
        color="orange"
        href={`https://forms.clickup.com/8459928/f/825mr-9671/KRFFR2BFKJCROV3B8Q?Civitai%20Username=${encodeURIComponent(
          currentUser.username
        )}&Prompt=${encodeURIComponent(
          (step.params as any).prompt
        )}&Negative%20Prompt=${encodeURIComponent(
          (step.params as any).negativePrompt
        )}&Job%20IDs=${encodeURIComponent(blockedImages.map((x) => x.jobId).join(','))}`}
      >
        <IconFlagQuestion size={20} />
      </LegacyActionIcon>
    </ButtonTooltip>
  );
}
