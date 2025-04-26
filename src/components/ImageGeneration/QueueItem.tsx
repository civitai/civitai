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
  IconInfoHexagon,
  IconTrash,
} from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
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
import { Currency } from '~/shared/utils/prisma/enums';
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
import styles from './QueueItem.module.scss';

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
      resources: (step.resources as any) ?? [],
      params: { ...(step.params as any), seed: undefined },
      remixOfId: step.metadata?.remixOfId,
      type: images[0].type, // TODO - type based off type of media
      workflow: step.params.workflow,
      sourceImage: (step.params as any).sourceImage,
      engine: (step.params as any).engine,
    });
  };

  const { prompt, ...details } = 'prompt' in params ? params : { ...params, prompt: undefined };

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

  const canRemix =
    step.params.workflow &&
    !['img2img-upscale', 'img2img-background-removal'].includes(step.params.workflow);

  const { data: workflowDefinitions } = trpc.generation.getWorkflowDefinitions.useQuery();
  const workflowDefinition = workflowDefinitions?.find((x) => x.key === params.workflow);

  const engine =
    step.metadata.params && 'engine' in step.metadata.params
      ? (step.metadata.params.engine as string)
      : undefined;

  const queuePosition = images[0]?.queuePosition;

  return (
    <Card ref={ref} withBorder px="xs" id={id} className={styles.root}>
      {inView && (
        <Card.Section py={4} inheritPadding withBorder>
          <div className={styles.header}>
            <div className={styles.status}>
              {!!images.length && (
                <GenerationStatusBadge
                  status={request.status}
                  complete={completedCount}
                  total={images.length}
                />
              )}
              {queuePosition && (
                <Badge size="sm" variant="light">
                  Queue Position: {queuePosition}
                </Badge>
              )}
            </div>
            <div className={styles.actions}>
              {canRemix && (
                <ButtonTooltip label="Remix">
                  <ActionIcon
                    variant="light"
                    color="blue"
                    onClick={handleGenerate}
                    data-activity="remix:queue-item"
                  >
                    <IconArrowsShuffle size={16} />
                  </ActionIcon>
                </ButtonTooltip>
              )}
              <ButtonTooltip label="Copy Job IDs">
                <ActionIcon variant="light" color="blue" onClick={handleCopy}>
                  <IconCheck size={16} style={{ display: copied ? 'block' : 'none' }} />
                  <IconInfoHexagon size={16} style={{ display: copied ? 'none' : 'block' }} />
                </ActionIcon>
              </ButtonTooltip>
              <CancelOrDeleteWorkflow workflowId={request.id} cancellable={cancellable} />
            </div>
          </div>
          {showDelayedMessage && (
            <Alert
              icon={<IconAlertTriangleFilled size={16} />}
              title="Generation is taking longer than expected"
              color="yellow"
              className={styles.delayed}
            >
              This generation is taking longer than usual. You can cancel it and try again, or wait
              a bit longer.
            </Alert>
          )}
          {failureReason && (
            <Alert
              icon={<IconAlertTriangleFilled size={16} />}
              title="Generation failed"
              color="red"
              className={styles.error}
            >
              {failureReason}
            </Alert>
          )}
          {resources.length > 0 && (
            <div className={styles.resource}>
              {resources.map((resource) => (
                <ResourceBadge key={resource.id} {...resource} />
              ))}
            </div>
          )}
        </Card.Section>
      )}
    </Card>
  );
}

const ResourceBadge = (props: GenerationResource) => {
  const { name, type } = props;
  return (
    <div className={styles.resource}>
      <div className={styles.resourceIcon}>
        <IconInfoHexagon size={16} />
      </div>
      <div className={styles.resourceName}>{name}</div>
    </div>
  );
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

