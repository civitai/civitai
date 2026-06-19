import type { RingProgressProps, TooltipProps } from '@mantine/core';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Loader,
  Menu,
  RingProgress,
  Text,
  Tooltip,
  Anchor,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import dynamic from 'next/dynamic';
import {
  IconAlertTriangleFilled,
  IconCube,
  IconDownload,
  IconX,
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
import { useRouter } from 'next/router';
import dayjs from '~/shared/utils/dayjs';
import { useEffect, useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';
import { GeneratedOutput } from '~/components/ImageGeneration/GeneratedOutput';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import {
  useGenerationConfig,
  useGenerationStatus,
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
import { useServerDomains } from '~/providers/AppProvider';
import { syncAccount } from '~/utils/sync-account';
import {
  encodeGenerationHandoff,
  GENERATION_HANDOFF_PARAM,
} from '~/components/generation_v2/utils/generation-url-handoff';
import { getGenerationSnapshotCache } from '~/components/generation_v2/utils/generation-snapshot-cache';
import type {
  AudioBlob,
  BlobData,
  ImageBlob,
  VideoBlob,
} from '~/shared/orchestrator/workflow-data';
import { numberWithCommas } from '~/utils/number-helpers';
import { getModelUrl } from '~/utils/string-helpers';
import type { Model3DViewableVariant } from '~/components/Model3D/Viewer/Model3DVariantViewer';
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
  const { unstableResources } = useGenerationConfig();

  const { copied, copy } = useClipboard();

  const [showDelayedMessage, setShowDelayedMessage] = useState(false);
  const { status } = request;
  const params = request.params;
  const resources = request.resources;

  const allImages = request.steps.flatMap((s) => s.output);

  // PolyGen (3D) workflows are rendered as their own queue card variant —
  // we deliberately do NOT spin up a WebGL viewer per queue card (5 queued
  // generations would mean 5 WebGL contexts on the page). Show the
  // thumbnail + a stub "Post from Generation" CTA; the full viewer lives
  // on the detail page (workstream D + G).
  const isPolyGen = request.steps.some((s) => s.$type === 'polyGen');

  const stepErrors = request.steps.flatMap((s) => s.errors ?? []);
  const failureReason = stepErrors.length
    ? stepErrors.join(',\n')
    : allImages.find((x) => !x.available && x.blockedReason)?.blockedReason;

  const processing = status === 'processing';
  const pending = orchestratorPendingStatuses.includes(status);
  const canceled = status === 'canceled';

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
    // Workflow-level replay: read directly from workflow.metadata (the form input
    // snapshot). Per-image remix lives on the GeneratedOutput menu and uses step
    // metadata for source-lineage cases.
    const replayParams = request.params;
    const isTxt2Img = replayParams?.workflow === 'txt2img';
    // PolyGen (3D Models) has no model selector — pin the ecosystem so the
    // form's discriminator activates the polyGen subgraph (auto-hiding the
    // checkpoint picker via Controller's null return) and lands the user
    // directly on the 3D Models segment with all params pre-filled.
    const isPolyGenReplay = request.steps.some((s) => s.$type === 'polyGen');
    const polyGenOverrides = isPolyGenReplay
      ? {
          ecosystem: 'PolyGen',
          workflow:
            (replayParams?.workflow as string | undefined) ??
            (request.steps.some(
              (s) => s.$type === 'polyGen' && (s.params as any)?.process === 'imageTo3D'
            )
              ? 'img2model3d'
              : 'txt2model3d'),
        }
      : {};
    generationGraphStore.setData({
      params: {
        ...replayParams,
        seed: null,
        // Clear images for txt2img to avoid stale data
        ...(isTxt2Img ? { images: null } : {}),
        ...polyGenOverrides,
      },
      // PolyGen has no checkpoint/LoRA resources — drop any inherited ones so
      // the form provider doesn't push a `model` value onto the polyGen branch.
      resources: isPolyGenReplay ? [] : request.resources,
      runType: 'replay',
      remixOfId: request.remixOfId,
    });
  };

  const { prompt, ...details } = params as { prompt: string };

  const hasUnstableResources = resources.some((x) => unstableResources.includes(x.id));
  const overwriteStatusLabel = canceled
    ? 'cancelled - This generation was cancelled. Any undelivered generations were refunded.'
    : hasUnstableResources && status === 'failed'
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

  // PolyGen workflows don't always carry `params.workflow` consistently
  // (the orchestrator-side step is the source of truth), so derive the
  // process label directly from the polyGen step input. Shown as its own
  // chip in the card header so the user always sees "Image to 3D" /
  // "Text to 3D" even when the workflowConfig lookup misses.
  const polyGenStep = request.steps.find((s) => s.$type === 'polyGen');
  const polyGenProcess = (polyGenStep?.params as { process?: string } | undefined)
    ?.process;
  const polyGenChipLabel =
    polyGenProcess === 'imageTo3D'
      ? 'Image to 3D'
      : polyGenProcess === 'textTo3D'
      ? 'Text to 3D'
      : polyGenStep
      ? '3D Model'
      : null;

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
              {polyGenChipLabel && !workflowDefinition && (
                <Badge
                  radius="sm"
                  color="violet"
                  size="sm"
                  classNames={{ label: 'overflow-hidden' }}
                >
                  {polyGenChipLabel}
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

      {inView && isPolyGen && (
        <div className="flex flex-col gap-3 py-3 @container">
          {prompt && <LineClamp lh={1.3}>{prompt}</LineClamp>}
          {failureReason && <Alert color="red">{failureReason}</Alert>}
          <Model3DQueueCardOutputs
            request={request}
            pending={pending}
            processing={processing}
          />
        </div>
      )}

      {inView && !isPolyGen && (
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

            {stepDisplay === 'inline' && (
              <WorkflowStatusAlert status={status} failureReason={failureReason} />
            )}

            {stepDisplay === 'separate' ? (
              request.steps
                .filter((step) => !step.suppressOutput)
                .map((step) => {
                  const stepConfig =
                    workflowConfigs[step.params.workflow as keyof typeof workflowConfigs];
                  return (
                    <div key={step.name} className="flex flex-col gap-2">
                      <Text size="xs" c="dimmed" fw={500}>
                        {stepConfig?.label ?? step.name}
                      </Text>
                      <StepOutputs
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
              <StepOutputs
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
  const { unstableResources } = useGenerationConfig();
  const { model, id, name, epochDetails } = resource;
  const unstable = unstableResources?.includes(id);
  const truncatedModelName =
    model.name.length > 30 ? `${model.name.slice(0, 30).trimEnd()}…` : model.name;

  return (
    <Button.Group className="max-w-full">
      <Button
        size="compact-sm"
        variant="default"
        component={Link}
        href={getModelUrl({ modelId: model.id, modelName: model.name, modelVersionId: id })}
        onClick={() => generationGraphPanel.close()}
        leftSection={
          unstable ? (
            <Tooltip label="Unstable resource">
              <IconAlertTriangleFilled size={14} className="text-yellow-500" />
            </Tooltip>
          ) : undefined
        }
        color={unstable ? 'yellow' : undefined}
        className="min-w-0 flex-1"
        classNames={{ label: 'truncate' }}
      >
        {truncatedModelName} - {name}
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
function StepOutputs({
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
  const images = step ? step.output : request.steps.flatMap((s) => s.output);
  const allDisplayImages = step ? step.displayOutput : request.displayOutput;
  // PolyGen workflows render through `Model3DQueueCardOutputs` (the `isPolyGen`
  // branch above), so model3d blobs never reach this grid — narrow them out
  // here so `GeneratedOutput` keeps its image/video/audio-only contract.
  const displayImages = allDisplayImages
    .filter(
      (img): img is ImageBlob | VideoBlob | AudioBlob => img.type !== 'model3d'
    )
    .filter((img) => matchesMarkerTags(img, markerTags));
  const blockedReasons = step ? step.blockedReasons : request.blockedReasons;

  const stepFailure = step
    ? step.errors?.join(',\n') ||
      step.output.find((x) => !x.available && x.blockedReason)?.blockedReason
    : undefined;

  return (
    <>
      {step && <WorkflowStatusAlert status={request.status} failureReason={stepFailure} />}
      <div
        className={clsx(classes.grid, {
          [classes.asSidebar]: !features.largerGenerationImages,
        })}
      >
        {displayImages.map((image) =>
          image.blockedReason === 'siteRestricted' ? (
            <SiteRestrictedBlock key={image.id} image={image} />
          ) : (
            <GeneratedOutput key={image.id} image={image} />
          )
        )}
        <BlockedBlocks
          blockedReasons={blockedReasons.filter((r) => r !== 'siteRestricted')}
          workflowId={request.id}
          transactions={request.transactions}
        />
        {(pending || processing) && (
          <TwCard
            className="items-center justify-center border"
            style={{ aspectRatio: images[0]?.aspect ?? 1 }}
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

/**
 * Status-specific alerts shown in place of the red failure alert. Statuses not in
 * the map fall through to the `failureReason` red alert (see `WorkflowStatusAlert`).
 */
const workflowStatusAlertMap: Partial<Record<WorkflowStatus, { color: string; message: string }>> =
  {
    canceled: { color: 'gray', message: 'This generation was cancelled.' },
  };

function WorkflowStatusAlert({
  status,
  failureReason,
}: {
  status: WorkflowStatus;
  failureReason?: string | null;
}) {
  const statusAlert = workflowStatusAlertMap[status];
  if (statusAlert) return <Alert color={statusAlert.color}>{statusAlert.message}</Alert>;
  if (failureReason) return <Alert color="red">{failureReason}</Alert>;
  return null;
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
  const cancellingDeleting = deleteMutation.isPending || cancelMutation.isPending || cancelling;

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

/**
 * Per-image card shown on .com when NSFW output is blocked.
 * Displays a prompt/seed summary and a CTA to view on civitai.red.
 */
function SiteRestrictedBlock({ image }: { image: BlobData }) {
  const redDomain = useServerDomains().red;

  const buildRedUrl = () => {
    const base = `//${redDomain}/generate`;
    const cached = getGenerationSnapshotCache();
    if (!cached) return syncAccount(base);
    const handoff = encodeGenerationHandoff(cached.snapshot, {
      computedKeys: cached.computedKeys,
    });
    return syncAccount(handoff ? `${base}?${GENERATION_HANDOFF_PARAM}=${handoff}` : base);
  };

  return (
    <TwCard className="flex aspect-square size-full flex-col items-center justify-center gap-2 border p-3">
      <Text c="yellow" fw="bold" align="center" size="sm">
        Mature Content
      </Text>
      <Text align="center" size="xs">
        This image was rated mature and cannot be viewed on this site.
      </Text>
      {redDomain && (
        <Button
          component="a"
          href={buildRedUrl()}
          target="_blank"
          rel="noreferrer nofollow"
          color="red"
          variant="light"
          size="compact-sm"
        >
          Unlock on civitai.red
        </Button>
      )}
    </TwCard>
  );
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

// Friendly labels for the non-yellow Buzz types a user may have spent to generate.
const refundableBuzzLabelMap: Partial<Record<TransactionInfo['accountType'], string>> = {
  blue: 'Blue',
  green: 'Green',
};

function CanUpgradeBlock({
  workflowId,
  transactions,
}: {
  workflowId: string;
  transactions: TransactionInfo[];
}) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const serverDomains = useServerDomains();
  const isPaidMember = currentUser?.tier && currentUser.tier !== 'free';
  const pricingHref = syncAccount(`//${serverDomains.green}/pricing`);

  const yellowBuzzRequired = transactions.reduce<number>((acc, transaction) => {
    if (transaction.accountType === 'yellow') return acc;
    if (transaction.type === 'credit') return acc - transaction.amount;
    else return acc + transaction.amount;
  }, 0);

  // Figure out which non-yellow Buzz type(s) were spent to generate this content, so we
  // can tell the user that Buzz will be refunded once they unlock with yellow Buzz.
  const refundedBuzzLabels = Array.from(
    new Set(
      transactions
        .filter((t) => t.accountType !== 'yellow' && t.type === 'debit')
        .map((t) => refundableBuzzLabelMap[t.accountType] ?? 'Buzz')
    )
  );
  const refundedLabel = refundedBuzzLabels.length === 1 ? `${refundedBuzzLabels[0]} Buzz` : 'Buzz';

  const { mutate, isPending: isLoading } = useUpdateWorkflow();

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
      <Text align="center" size="xs" c="dimmed">
        The {refundedLabel} you used to generate this content will be refunded.
      </Text>
      {!isPaidMember && (
        <Text align="center" size="xs" c="dimmed">
          Or{' '}
          {features.isGreen ? (
            <Anchor component={Link} href={pricingHref} size="xs">
              become a member
            </Anchor>
          ) : (
            <Anchor href={pricingHref} target="_blank" rel="noreferrer nofollow" size="xs">
              become a member
            </Anchor>
          )}{' '}
          to use Blue Buzz for mature content
        </Text>
      )}
    </>
  );
}

// Lazy-mounted so the GLB loader bundle only ships for users who actually
// toggle the inline preview on. The variant-aware wrapper handles
// switching between Base / Rigged / Animated / Walking / Running on its
// own; it falls through to Model3DViewer for the actual three.js mount.
const Model3DVariantViewerDynamic = dynamic(
  () =>
    import('~/components/Model3D/Viewer/Model3DVariantViewer').then(
      (m) => m.Model3DVariantViewer
    ),
  { ssr: false }
);

/**
 * Queue card body for 3D Model (polyGen) workflows.
 *
 * Renders the generator-provided thumbnail (an `ImageBlob` carried on the
 * polyGen step's output) and, on opt-in, an inline three.js viewer mounted
 * on the GLB URL. The viewer only mounts when the user toggles it on, so
 * the feed doesn't spin up N WebGL contexts unprompted.
 *
 * "Save 3D Model" lazily materializes a `Model3D` Draft from the workflow:
 * the server copies the orchestrator's expiring GLB / FBX blobs into our
 * S3 under `3d/`, ingests the thumbnail through the standard image
 * pipeline (NSFW / CSAM scan, real `Image` row), and writes the Draft +
 * `Model3DFile` rows — the same final write the moderator seed page uses.
 * After that we land the owner in `/3d-models/{id}/edit` to set name +
 * description (WYSIWYG) before publishing. No Image Post is created here;
 * that's a separate optional flow off the published 3D model page.
 */
function Model3DQueueCardOutputs({
  request,
  pending,
  processing,
}: {
  request: WorkflowData;
  pending: boolean;
  processing: boolean;
}) {
  const router = useRouter();
  const [viewerOpen, setViewerOpen] = useState(false);
  console.log('Model3DQueueCardOutputs', { request, pending, processing });

  // PolyGen outputs flow through `formatStepOutputs` as `Model3DBlob`s —
  // one per generated mesh, with the 2D preview carried on `thumbnailUrl`
  // and the GLB at `url`. Take the first such blob across the workflow.
  const model3dBlob = request.steps
    .flatMap((s) => s.output)
    .find((blob) => blob?.type === 'model3d');
  const thumbnailUrl =
    model3dBlob?.type === 'model3d' ? model3dBlob.thumbnailUrl ?? null : null;
  const modelUrl = model3dBlob?.type === 'model3d' ? model3dBlob.url ?? null : null;
  const modelFormat =
    model3dBlob?.type === 'model3d' ? model3dBlob.format ?? 'glb' : 'glb';

  // Viewable variants — GLB-only siblings the inline three.js viewer can
  // mount (FBX isn't supported by GLTFLoader, armature-only files render
  // as empty space). Walking / running play their embedded animations
  // the moment they're selected via the viewer's AnimationMixer.
  const viewableVariants: Model3DViewableVariant[] = (() => {
    if (model3dBlob?.type !== 'model3d') return [];
    const isViewable = (fmt: string) => fmt.toLowerCase() === 'glb';
    const list: Model3DViewableVariant[] = [];
    if (modelUrl && isViewable(modelFormat))
      list.push({ key: 'base', label: 'Base', url: modelUrl, format: modelFormat });
    const pushAsset = (
      key: string,
      label: string,
      asset: { url: string; format: string } | undefined
    ) => {
      if (asset?.url && isViewable(asset.format))
        list.push({ key, label, url: asset.url, format: asset.format });
    };
    pushAsset('rigged', 'Rigged', model3dBlob.rigged);
    pushAsset('animated', 'Animated', model3dBlob.animated);
    pushAsset('walking', 'Walking', model3dBlob.basicAnimations?.walking);
    pushAsset('running', 'Running', model3dBlob.basicAnimations?.running);
    return list;
  })();

  const showSpinner = pending || processing;
  // Terminal failure states — workflow won't produce a thumbnail. The
  // orchestrator auto-refunds spent buzz on these, so surface that to the
  // user instead of the ambiguous "No preview available yet".
  const isFailed =
    request.status === 'failed' ||
    request.status === 'expired' ||
    request.status === 'canceled';
  const failureLabel =
    request.status === 'expired'
      ? 'Generation expired'
      : request.status === 'canceled'
      ? 'Generation canceled'
      : 'Generation failed';
  const isComplete = !pending && !processing && !isFailed;

  // Materialize the Model3D draft on demand. The mutation is idempotent on
  // workflowId: it copies the orchestrator blobs to our S3, ingests the
  // thumbnail through the standard image pipeline, and writes the Draft +
  // Model3DFile rows. After that we land the owner in the regular Model3D
  // edit page where they set name + description (WYSIWYG) and publish.
  // No Post is created here — Posts are a separate, optional thing the
  // owner can do later from the Model3D detail page.
  const ensureModel3D = trpc.model3d.ensureFromWorkflow.useMutation({
    onError: (error) => {
      showErrorNotification({
        title: 'Could not save your 3D model',
        error: new Error(error.message),
      });
    },
  });

  const handleSaveToLibrary = async () => {
    try {
      const draft = await ensureModel3D.mutateAsync({ workflowId: request.id });
      await router.push(`/3d-models/${draft.id}/edit`);
    } catch {
      // notification already fired via mutation onError
    }
  };

  // Enable once the workflow has succeeded and produced a Model3DBlob —
  // the GLB URL is sufficient for the server-side ensure handler to do the
  // rest. No more "waiting for a draft that never materializes" stuck state.
  const ctaBusy = ensureModel3D.isPending;
  const ctaDisabled = !isComplete || !model3dBlob || ctaBusy;

  return (
    <div className="flex flex-col gap-2">
      <TwCard
        className="relative flex aspect-square items-center justify-center overflow-hidden border"
        style={{ minHeight: 240 }}
      >
        {viewerOpen && viewableVariants.length ? (
          <>
            {/* Variant-aware viewer — switches between Base / Rigged /
                Animated / Walking / Running via the wrapper's top-left
                Select. Walking and Running auto-play their embedded
                animations (AnimationMixer wired into Model3DViewer). The
                `compact` switch makes the viewer fill its parent TwCard
                instead of imposing min-h-[480px]. */}
            <Model3DVariantViewerDynamic
              variants={viewableVariants}
              compact
              className="size-full"
            />
            <Tooltip label="Close 3D preview" withinPortal position="left">
              <LegacyActionIcon
                variant="filled"
                color="dark"
                radius="xl"
                size="sm"
                aria-label="Close 3D preview"
                onClick={() => setViewerOpen(false)}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}
              >
                <IconX size={14} stroke={2} />
              </LegacyActionIcon>
            </Tooltip>
          </>
        ) : thumbnailUrl ? (
          <>
            {/* size-full so the thumbnail fills the aspect-square card.
                The orchestrator-emitted thumbnail is square (1024×1024)
                so object-cover matches object-contain visually but
                guarantees full coverage on any future non-square sources. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnailUrl}
              alt="3D model thumbnail"
              className="size-full object-cover"
            />
            {modelUrl && (
              <Tooltip label="View in 3D" withinPortal position="left">
                <LegacyActionIcon
                  variant="filled"
                  color="dark"
                  radius="xl"
                  size="sm"
                  aria-label="Open inline 3D viewer"
                  onClick={() => setViewerOpen(true)}
                  style={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}
                >
                  <IconCube size={14} stroke={2} />
                </LegacyActionIcon>
              </Tooltip>
            )}
          </>
        ) : showSpinner ? (
          <div className="flex flex-col items-center gap-2">
            <Loader size={24} />
            <Text c="dimmed" size="xs" align="center">
              Generating 3D model…
            </Text>
          </div>
        ) : isFailed ? (
          <div className="flex flex-col items-center gap-2 px-4 text-center">
            <IconAlertTriangleFilled size={24} className="text-red-5" />
            <Text size="sm" fw={600} c="red.4">
              {failureLabel}
            </Text>
            <Text size="xs" c="dimmed">
              Your Buzz has been refunded.
            </Text>
          </div>
        ) : (
          <Text c="dimmed" size="xs" align="center">
            No preview available yet
          </Text>
        )}
      </TwCard>

      <div className="flex gap-2">
        <Button
          onClick={handleSaveToLibrary}
          variant="light"
          size="compact-sm"
          fullWidth
          loading={ctaBusy}
          disabled={ctaDisabled}
        >
          Post
        </Button>
        {/* Download the orchestrator's presigned URLs directly. URLs are
            short-lived, so this is "download now or never" — same constraint
            as Save 3D Model (after which we copy them to our own S3). The
            polyGen output can carry up to ~12 files (base + rigged +
            animated + walking + running, each with their own glb / fbx /
            armature siblings); flatten them all into the menu. */}
        {(() => {
          // Each downloadable file is one (variant label, format, url) row.
          // Labels mirror the variant taxonomy used by Model3DFile.variant
          // server-side so a user's downloaded files match what shows up
          // later on the saved Model3D detail page.
          type DownloadEntry = { label: string; format: string; url: string };
          const entries: DownloadEntry[] = [];

          if (isComplete && model3dBlob?.type === 'model3d') {
            const pushAsset = (
              label: string,
              asset:
                | {
                    format: string;
                    url: string;
                    fbx?: { format: string; url: string };
                    armature?: { format: string; url: string };
                  }
                | undefined
            ) => {
              if (!asset?.url) return;
              entries.push({ label, format: asset.format, url: asset.url });
              if (asset.fbx?.url)
                entries.push({
                  label,
                  format: asset.fbx.format,
                  url: asset.fbx.url,
                });
              if (asset.armature?.url)
                entries.push({
                  label: `${label} (armature)`,
                  format: asset.armature.format,
                  url: asset.armature.url,
                });
            };

            // Base mesh: the primary GLB + its alternate-format sibling
            // (lives on the legacy `variants[]` array, where polygen still
            // emits the base FBX).
            if (modelUrl) entries.push({ label: 'Base', format: modelFormat, url: modelUrl });
            for (const v of model3dBlob.variants ?? []) {
              if (v?.url) entries.push({ label: 'Base', format: v.format, url: v.url });
            }

            // New sibling meshes from @civitai/client 0.2.0-beta.72.
            pushAsset('Rigged', model3dBlob.rigged);
            pushAsset('Animated', model3dBlob.animated);
            pushAsset('Walking', model3dBlob.basicAnimations?.walking);
            pushAsset('Running', model3dBlob.basicAnimations?.running);
          }

          if (!entries.length) {
            return (
              <Button
                variant="light"
                size="compact-sm"
                fullWidth
                disabled
                leftSection={<IconDownload size={14} stroke={2} />}
              >
                Download
              </Button>
            );
          }

          // Single file — anchor button, no menu.
          if (entries.length === 1) {
            const f = entries[0];
            return (
              <Button
                component="a"
                href={f.url}
                download={`civitai-3d-${request.id}.${f.format}`}
                target="_blank"
                rel="noopener noreferrer"
                variant="light"
                size="compact-sm"
                fullWidth
                leftSection={<IconDownload size={14} stroke={2} />}
              >
                Download {f.format.toUpperCase()}
              </Button>
            );
          }

          // Build deterministic filenames + collision-safe React keys.
          // Variant labels go into the filename so the user's filesystem
          // can tell rigged.glb apart from base.glb after a "save all" sweep.
          const slug = (s: string) =>
            s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          const filename = (e: DownloadEntry) =>
            e.label === 'Base'
              ? `civitai-3d-${request.id}.${e.format}`
              : `civitai-3d-${request.id}.${slug(e.label)}.${e.format}`;

          return (
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button
                  variant="light"
                  size="compact-sm"
                  fullWidth
                  leftSection={<IconDownload size={14} stroke={2} />}
                >
                  Download
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {entries.map((e, i) => (
                  <Menu.Item
                    key={`${e.label}-${e.format}-${i}`}
                    component="a"
                    href={e.url}
                    download={filename(e)}
                    target="_blank"
                    rel="noopener noreferrer"
                    leftSection={<IconDownload size={14} stroke={2} />}
                  >
                    {e.label === 'Base'
                      ? e.format.toUpperCase()
                      : `${e.label} · ${e.format.toUpperCase()}`}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          );
        })()}
      </div>
    </div>
  );
}
