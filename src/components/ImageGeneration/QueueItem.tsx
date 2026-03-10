import type { RingProgressProps, TooltipProps } from '@mantine/core';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Loader,
  RingProgress,
  Text,
  Tooltip,
  Anchor,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import {
  IconAlertTriangleFilled,
  IconArrowsShuffle,
  IconBan,
  IconPlus,
  IconCheck,
  IconFlagQuestion,
  IconInfoHexagon,
  IconTrash,
  IconLink,
} from '@tabler/icons-react';
import { NextLink as Link, NextLink } from '~/components/NextLink/NextLink';
import dayjs from '~/shared/utils/dayjs';
import { useEffect, useState } from 'react';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import {
  useGenerationStatus,
  useUnstableResources,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { GenerationStatusBadge } from '~/components/ImageGeneration/GenerationStatusBadge';
import {
  matchesMarkerTags,
  useCancelTextToImageRequest,
  useDeleteTextToImageRequest,
  useUpdateWorkflow,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import type { TransactionInfo, WorkflowStatus } from '@civitai/client';
import { TimeSpan } from '@civitai/client';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { TwCard } from '~/components/TwCard/TwCard';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { GenerationResource } from '~/shared/types/generation.types';
import { type WorkflowData, type StepData } from '~/server/services/orchestrator';
import { orchestratorPendingStatuses } from '~/shared/constants/generation.constants';
import { getEcosystem } from '~/shared/constants/basemodel.constants';
import { generationGraphPanel, generationGraphStore } from '~/store/generation-graph.store';
import { formatDateMin } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { TransactionsPopover } from '~/components/ImageGeneration/GenerationForm/TransactionsPopover';
import classes from './QueueItem.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '~/shared/utils/prisma/enums';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { workflowConfigs } from '~/shared/data-graph/generation/config/workflows';

const PENDING_PROCESSING_STATUSES: WorkflowStatus[] = [
  ...orchestratorPendingStatuses,
  'processing',
];
const LONG_DELAY_TIME = 5; // minutes
const EXPIRY_TIME = 10; // minutes
const delayTimeouts = new Map<string, NodeJS.Timeout>();

export function QueueItem({
  request,
  id,
  markerTags,
}: {
  request: WorkflowData;
  id: string;
  markerTags?: string[];
}) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const [ref, inView] = useInViewDynamic({ id });

  const generationStatus = useGenerationStatus();
  const { unstableResources } = useUnstableResources();

  const { copied, copy } = useClipboard();

  const [showDelayedMessage, setShowDelayedMessage] = useState(false);
  const { status } = request;
  const params = request.params;
  const resources = request.resources;

  const allImages = request.steps.flatMap((s) => s.images);

  const stepErrors = request.steps.flatMap((s) => s.errors ?? []);
  const failureReason = stepErrors.length
    ? stepErrors.join(',\n')
    : allImages.find((x) => x.status === 'failed' && x.blockedReason)?.blockedReason;

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

  const minTimeout = request.steps.reduce((min, s) => {
    const minutes = s.timeout ? new TimeSpan(s.timeout).minutes : EXPIRY_TIME;
    return Math.min(min, minutes);
  }, EXPIRY_TIME);
  const refundTime = dayjs(request.createdAt).add(minTimeout, 'minute').toDate();

  const handleCopy = () => {
    copy(request.id);
  };

  const handleGenerate = () => {
    const isTxt2Img = request.params?.workflow === 'txt2img';
    generationGraphStore.setData({
      params: {
        ...request.params,
        seed: null,
        // Clear images for txt2img to avoid stale data
        ...(isTxt2Img ? { images: null } : {}),
      },
      resources: request.resources,
      runType: 'replay',
      remixOfId: request.remixOfId,
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

  const completedCount = request.completedCount;
  const processingCount = request.processingCount;

  const canRemix =
    (params.workflow &&
      !['img2img-upscale', 'img2img-background-removal'].includes(params.workflow as string)) ||
    (!!params.engine && allImages.length > 0);

  const workflowDefinition = workflowConfigs[params.workflow as keyof typeof workflowConfigs];

  const engine = params.engine as string | undefined;
  const version = params.version as string | undefined;

  const queuePosition = request.steps.find((s) => s.queuePosition)?.queuePosition;
  const stepDisplay = workflowDefinition?.stepDisplay ?? 'inline';

  return (
    <Card ref={ref} withBorder px="xs" id={id}>
      {inView && (
        <Card.Section py={4} inheritPadding withBorder>
          <div className="flex justify-between">
            <div className="flex flex-wrap items-center gap-1">
              {!!allImages.length && (
                <GenerationStatusBadge
                  status={request.status}
                  complete={completedCount}
                  processing={processingCount}
                  quantity={allImages.length}
                  tooltipLabel={overwriteStatusLabel}
                  progress
                />
              )}

              <Text size="xs" c="dimmed">
                {formatDateMin(request.createdAt)}
              </Text>
              {!!request.cost?.total && (
                <GenerationCostPopover
                  workflowCost={request.cost}
                  transactions={request.transactions}
                  readOnly
                  variant="badge"
                />
              )}
              {request.transactions.length > 0 && (
                <TransactionsPopover data={request.transactions} />
              )}
              {!!request.duration && currentUser?.isModerator && (
                <Badge color="yellow">Duration: {request.duration}</Badge>
              )}
              {workflowDefinition && (
                <Badge
                  radius="sm"
                  color="violet"
                  size="sm"
                  classNames={{ label: 'overflow-hidden' }}
                >
                  {workflowDefinition.label}
                </Badge>
              )}
              {engine && (
                <Badge
                  radius="sm"
                  color="violet"
                  size="sm"
                  classNames={{ label: 'overflow-hidden' }}
                >
                  {`${engine}${version ? ` ${version}` : ''}`}
                </Badge>
              )}
            </div>
            <div className="flex gap-1">
              <SubmitBlockedImagesForReviewButton request={request} />
              {currentUser?.isModerator && (
                <ButtonTooltip {...tooltipProps} label="Go to Workflow">
                  <LegacyActionIcon
                    size="md"
                    p={4}
                    radius={0}
                    component="a"
                    href={`https://orchestration-dashboard-new.civitai.com/job-search?workflow=${request.id}`}
                    target="_blank"
                    onClick={handleCopy}
                  >
                    <IconLink />
                  </LegacyActionIcon>
                </ButtonTooltip>
              )}
              <ButtonTooltip {...tooltipProps} label="Copy Workflow ID">
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
            {showDelayedMessage &&
              cancellable &&
              !request.steps.some((s) => s.$type === 'videoGen') && (
                <Alert color="yellow" p={0}>
                  <div className="flex items-center gap-2 px-2 py-1">
                    <Text size="xs" c="yellow" lh={1}>
                      <IconAlertTriangleFilled size={20} />
                    </Text>
                    <Text size="xs" lh={1.2} c="yellow">
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

            {prompt && <LineClamp lh={1.3}>{prompt}</LineClamp>}

            {resources.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {resources.map((resource) => (
                  <ResourceRow key={resource.id} resource={resource} />
                ))}
              </div>
            )}

            {stepDisplay === 'inline' && failureReason && (
              <Alert color="red">{failureReason}</Alert>
            )}

            {stepDisplay === 'separate' ? (
              request.steps.map((step) => {
                const stepConfig =
                  workflowConfigs[step.params.workflow as keyof typeof workflowConfigs];
                return (
                  <div key={step.name} className="flex flex-col gap-2">
                    <Text size="xs" c="dimmed" fw={500}>
                      {stepConfig?.label ?? step.name}
                    </Text>
                    <StepImages
                      step={step}
                      request={request}
                      features={features}
                      pending={pending}
                      processing={processing}
                      queuePosition={queuePosition}
                      markerTags={markerTags}
                    />
                  </div>
                );
              })
            ) : (
              <StepImages
                step={null}
                request={request}
                features={features}
                pending={pending}
                processing={processing}
                queuePosition={queuePosition}
                markerTags={markerTags}
              />
            )}
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

function ResourceRow({ resource }: { resource: GenerationResource }) {
  const { unstableResources } = useUnstableResources();
  const { model, id, name, epochDetails } = resource;
  const unstable = unstableResources?.includes(id);

  return (
    <Button.Group>
      <Button
        size="compact-sm"
        variant="default"
        component={Link}
        href={`/models/${model.id}?modelVersionId=${id}`}
        onClick={() => generationGraphPanel.close()}
        leftSection={
          unstable ? (
            <Tooltip label="Unstable resource">
              <IconAlertTriangleFilled size={14} className="text-yellow-500" />
            </Tooltip>
          ) : undefined
        }
        color={unstable ? 'yellow' : undefined}
      >
        {model.name} - {name}
        {epochDetails?.epochNumber && ` #${epochDetails.epochNumber}`}
      </Button>
      <ButtonTooltip {...tooltipProps} label="Generate with this resource">
        <Button
          size="compact-sm"
          variant="default"
          px={4}
          onClick={() => {
            generationGraphStore.setData({
              params: { ecosystem: getEcosystem(resource.baseModel)?.key },
              resources: [resource],
              runType: 'run',
            });
            generationGraphPanel.open();
          }}
        >
          <IconPlus size={14} />
        </Button>
      </ButtonTooltip>
    </Button.Group>
  );
}

/**
 * Renders the image grid for a single step or all steps (inline mode).
 * When `step` is null, renders all workflow images flattened.
 */
function StepImages({
  step,
  request,
  features,
  pending,
  processing,
  queuePosition,
  markerTags,
}: {
  step: StepData | null;
  request: WorkflowData;
  features: ReturnType<typeof useFeatureFlags>;
  pending: boolean;
  processing: boolean;
  queuePosition?: WorkflowData['steps'][number]['queuePosition'];
  markerTags?: string[];
}) {
  const images = step ? step.images : request.steps.flatMap((s) => s.images);
  const allDisplayImages = step ? step.displayImages : request.displayImages;
  const displayImages = allDisplayImages.filter((img) => matchesMarkerTags(img, markerTags));
  const blockedReasons = step ? step.blockedReasons : request.blockedReasons;

  const stepFailure = step
    ? step.errors?.join(',\n') ||
      step.images.find((x) => x.status === 'failed' && x.blockedReason)?.blockedReason
    : undefined;

  return (
    <>
      {stepFailure && <Alert color="red">{stepFailure}</Alert>}
      <div
        className={clsx(classes.grid, {
          [classes.asSidebar]: !features.largerGenerationImages,
        })}
      >
        {displayImages.map((image) => (
          <GeneratedImage key={image.id} image={image} />
        ))}
        <BlockedBlocks
          blockedReasons={blockedReasons}
          workflowId={request.id}
          transactions={request.transactions}
        />
        {(pending || processing) && images[0] && (
          <TwCard
            className="items-center justify-center border"
            style={{ aspectRatio: images[0].aspect }}
          >
            {processing && (
              <>
                <Loader size={24} />
                <Text c="dimmed" size="xs" align="center">
                  Generating
                </Text>
              </>
            )}
            {pending &&
              (queuePosition ? (
                <>
                  {queuePosition.support === 'unavailable' && (
                    <Text c="dimmed" size="xs" align="center">
                      Request queued — your generation will begin shortly
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
    </>
  );
}

const tooltipProps: Omit<TooltipProps, 'children' | 'label'> = {
  withinPortal: true,
  withArrow: true,
  color: 'dark',
  zIndex: imageGenerationDrawerZIndex + 1,
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

function SubmitBlockedImagesForReviewButton({ request }: { request: WorkflowData }) {
  const currentUser = useCurrentUser();
  if (!request.blockedCount || !currentUser?.username) return null;

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
          (request.params?.prompt as string) ?? ''
        )}&Negative%20Prompt=${encodeURIComponent(
          (request.params?.negativePrompt as string) ?? ''
        )}&Workflow%20ID=${request.id}`}
      >
        <IconFlagQuestion size={20} />
      </LegacyActionIcon>
    </ButtonTooltip>
  );
}

const imageBlockedReasonMap: Record<string, string | React.ComponentType<any>> = {
  ChildReference: 'An inappropriate child reference was detected.',
  Bestiality: 'Bestiality detected.',
  'Child Sexual - Anime': 'Inappropriate minor content detected.',
  'Child Sexual - Realistic': 'Inappropriate minor content detected.',
  NsfwLevel: 'Mature content restriction.',
  NSFWLevel:
    'One or more resources used in this generation cannot be used to generate mature content',
  NSFWLevelSourceImageRestricted:
    'If your input image lacks valid metadata, generation is restricted to PG or PG-13 outputs only.',
  // the following keys are managed in generationRequestHooks.ts
  privateGen: 'Private Generation is limited to PG and PG-13 content.',
  siteRestricted: 'Images with mature ratings are unavailable on this site',
  enableNsfw: EnableNsfwBlock,
  canUpgrade: CanUpgradeBlock,
};

function countOccurrences(arr: string[]): Record<string, number> {
  return arr.reduce((acc, str) => {
    acc[str] = (acc[str] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

function BlockedBlocks(props: {
  blockedReasons: string[];
  workflowId: string;
  transactions: TransactionInfo[];
}) {
  const map = countOccurrences(props.blockedReasons);
  const items = Object.entries(map).map(([value, count]) => ({ value, count }));
  if (!items.length) return null;
  return (
    <>
      {items.map(({ value, count }) => {
        const message = imageBlockedReasonMap[value] ?? value;

        return (
          <TwCard
            key={value}
            className="flex aspect-square size-full flex-col items-center justify-center gap-2 border p-3"
          >
            <Text c="red" fw="bold" align="center" size="sm">
              {count} Items Hidden
            </Text>
            {message
              ? renderBlockedReason(message, {
                  workflowId: props.workflowId,
                  transactions: props.transactions,
                })
              : null}
          </TwCard>
        );
      })}
    </>
  );
}

function renderBlockedReason(
  value: string | React.ComponentType<any>,
  props?: Record<string, any>
) {
  if (typeof value === 'string') {
    return (
      <Text align="center" size="sm">
        {value}
      </Text>
    );
  } else {
    const Component = value;
    return <Component {...props} />;
  }
}

function EnableNsfwBlock() {
  return (
    <Text align="center" size="sm">
      To view this content, enable mature content in your{' '}
      <Anchor component={NextLink} href="/user/account">
        account settings
      </Anchor>
    </Text>
  );
}

// TODO - show a separate message when the image is blocked for being green
/*
    ### Remove matureContentRestriction from a workflow
    PUT {{host}}/v2/consumer/workflows/6-20250724193706680
    Content-Type: application/json
    Authorization: Bearer {{accessToken}}

    {
      "allowMatureContent": true
    }
  */

function CanUpgradeBlock({
  workflowId,
  transactions,
}: {
  workflowId: string;
  transactions: TransactionInfo[];
}) {
  const yellowBuzzRequired = transactions.reduce<number>((acc, transaction) => {
    if (transaction.accountType === 'yellow') return acc;
    if (transaction.type === 'credit') return acc - transaction.amount;
    else return acc + transaction.amount;
  }, 0);

  const { mutate, isLoading } = useUpdateWorkflow();

  const { conditionalPerformTransaction } = useBuzzTransaction({
    accountTypes: ['yellow'],
    message: (requiredBalance) =>
      `You don't have enough yellow Buzz to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy more Buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  function handleClick() {
    if (isLoading) return;
    function performTransaction() {
      mutate({ workflowId, allowMatureContent: true });
    }
    conditionalPerformTransaction(yellowBuzzRequired, performTransaction);
  }

  return (
    <>
      <Text align="center" size="sm">
        Unlock this content with{' '}
        <Text component="span" c="yellow">
          yellow
        </Text>{' '}
        Buzz!
      </Text>
      <CurrencyBadge
        unitAmount={yellowBuzzRequired}
        currency={Currency.BUZZ}
        size="xs"
        className="cursor-pointer"
        type="yellow"
        onClick={handleClick}
        loading={isLoading}
      />
    </>
  );
}
