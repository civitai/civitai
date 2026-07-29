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
import dynamic from 'next/dynamic';
import {
  IconAlertTriangleFilled,
  IconArrowsMaximize,
  IconCube,
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
import dayjs from '~/shared/utils/dayjs';
import { useEffect, useState } from 'react';
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
import {
  orchestratorCompletedStatuses,
  orchestratorPendingStatuses,
} from '~/shared/constants/generation.constants';
import { getEcosystem } from '~/shared/constants/basemodel.constants';
import { generationGraphPanel, generationGraphStore } from '~/store/generation-graph.store';
import { formatDateMin } from '~/utils/date-helpers';
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
import {
  getModel3DViewableVariants,
  Model3DOutputActions,
} from '~/components/Model3D/Viewer/Model3DOutputActions';
import Model3DLightbox from '~/components/ImageGeneration/Model3DLightbox';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { workflowConfigs } from '~/shared/data-graph/generation/config/workflows';

const PENDING_PROCESSING_STATUSES: WorkflowStatus[] = [
  ...orchestratorPendingStatuses,
  'processing',
];
const LONG_DELAY_TIME = 5; // minutes
const EXPIRY_TIME = 10; // minutes
const delayTimeouts = new Map<string, NodeJS.Timeout>();

/** 3D ecosystem key → user-facing model name shown on the queue card. */
const POLYGEN_ECOSYSTEM_MODEL_LABELS: Record<string, string> = {
  PolyGen: 'Meshy',
  Tripo: 'Tripo',
  Hunyuan3D: 'Hunyuan3D',
};

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
    // 3D Models: pin the ecosystem so the form's discriminator activates the
    // matching subgraph (auto-hiding the checkpoint picker via Controller's
    // null return) and lands the user on the 3D Models segment with all params
    // pre-filled and the SAME model (Meshy/Tripo/Hunyuan3D) they generated
    // with. The ecosystem is carried in the params snapshot; fall back to
    // PolyGen (Meshy) for legacy items generated before the model selector.
    const isPolyGenReplay = request.steps.some((s) => s.$type === 'polyGen');
    const replayEcosystem = (replayParams?.ecosystem as string | undefined) ?? 'PolyGen';
    const polyGenOverrides = isPolyGenReplay
      ? {
          ecosystem: replayEcosystem,
          workflow:
            (replayParams?.workflow as string | undefined) ??
            // Tripo/Hunyuan3D are image-to-3D only; only PolyGen (Meshy) has a
            // text-to-3D branch, so consult its `process` for those items.
            (replayEcosystem !== 'PolyGen' ||
            request.steps.some(
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

  // PolyGen (txt2model3d / img2model3d) workflows don't reliably carry
  // `params.workflow` or `params.engine` — the orchestrator-side polyGen
  // step is the source of truth (see `isPolyGen` above). Without the
  // last clause the Remix button silently disappears on every PolyGen
  // queue item even though the saved `workflowMetadata.params` carries
  // everything the generator form needs to replay.
  const canRemix =
    (params.workflow &&
      !['img2img-upscale', 'img2img-background-removal'].includes(params.workflow as string)) ||
    (!!params.engine && allImages.length > 0) ||
    isPolyGen;

  const workflowDefinition = workflowConfigs[params.workflow as keyof typeof workflowConfigs];

  // PolyGen workflows don't always carry `params.workflow` consistently
  // (the orchestrator-side step is the source of truth), so derive the
  // process label directly from the polyGen step input. Shown as its own
  // chip in the card header so the user always sees "Image to 3D" /
  // "Text to 3D" even when the workflowConfig lookup misses.
  const polyGenStep = request.steps.find((s) => s.$type === 'polyGen');
  const polyGenProcess = (polyGenStep?.params as { process?: string } | undefined)?.process;
  const polyGenChipLabel =
    polyGenProcess === 'imageTo3D'
      ? 'Image to 3D'
      : polyGenProcess === 'textTo3D'
      ? 'Text to 3D'
      : polyGenStep
      ? '3D Model'
      : null;

  // The model (Meshy/Tripo/Hunyuan3D) that generated the mesh. Derived from the
  // ecosystem carried in the params snapshot; legacy items predate the model
  // selector, so any 3D item without an ecosystem is Meshy (PolyGen).
  const polyGenModelLabel = isPolyGen
    ? POLYGEN_ECOSYSTEM_MODEL_LABELS[params.ecosystem as string] ?? 'Meshy'
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
              {polyGenModelLabel && (
                <Badge
                  radius="sm"
                  color="violet"
                  size="sm"
                  classNames={{ label: 'overflow-hidden' }}
                >
                  {polyGenModelLabel}
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
          <Model3DQueueCardOutputs request={request} pending={pending} processing={processing} />
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
    .filter((img): img is ImageBlob | VideoBlob | AudioBlob => img.type !== 'model3d')
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
        Unlock with{' '}
        <Text component="span" c="yellow">
          yellow
        </Text>{' '}
        Buzz
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
        Your {refundedLabel} will be refunded.
        {!isPaidMember && (
          <>
            {' '}
            {features.isGreen ? (
              <Anchor component={Link} href={pricingHref} size="xs">
                Become a member
              </Anchor>
            ) : (
              <Anchor href={pricingHref} target="_blank" rel="noreferrer nofollow" size="xs">
                Become a member
              </Anchor>
            )}{' '}
            to use Blue Buzz for mature content.
          </>
        )}
      </Text>
    </>
  );
}

// Lazy-mounted so the GLB loader bundle only ships for users who actually
// toggle the inline preview on. The variant-aware wrapper handles
// switching between Base / Rigged / Animated / Walking / Running on its
// own; it falls through to Model3DViewer for the actual three.js mount.
const Model3DVariantViewerDynamic = dynamic(
  () =>
    import('~/components/Model3D/Viewer/Model3DVariantViewer').then((m) => m.Model3DVariantViewer),
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
  const features = useFeatureFlags();
  const [viewerOpen, setViewerOpen] = useState(false);

  // PolyGen outputs flow through `formatStepOutputs` as `Model3DBlob`s —
  // one per generated mesh, with the GLB at `url`. Take the first such blob
  // across the workflow.
  const model3dBlob = request.steps
    .flatMap((s) => s.output)
    .find((blob) => blob?.type === 'model3d');
  const blob = model3dBlob?.type === 'model3d' ? model3dBlob : null;
  const modelUrl = blob?.url ?? null;

  // Same NSFW gates as the image grid — the mesh inherits its rating from the
  // preview render server-side, so a mature result must resolve its block
  // (yellow-Buzz unlock / enable NSFW / site restriction) before the
  // thumbnail, viewer, or downloads are exposed.
  if (blob?.blockedReason) {
    return (
      <div
        className={clsx(classes.grid, {
          [classes.asSidebar]: !features.largerGenerationImages,
        })}
      >
        {blob.blockedReason === 'siteRestricted' ? (
          <SiteRestrictedBlock image={blob} />
        ) : (
          <BlockedBlocks
            blockedReasons={[blob.blockedReason]}
            workflowId={request.id}
            transactions={request.transactions}
          />
        )}
      </div>
    );
  }

  // Prefer the chained `model3DPreview` step's render (a controllable-angle 2D
  // preview). The preview step is `suppressOutput`, so its image only surfaces
  // here as the 3D card thumbnail — never as its own output card.
  const previewStep = request.steps.find((s) => s.$type === 'model3DPreview');
  const previewImage = previewStep?.output.find(
    (b): b is ImageBlob => b?.type === 'image' && b.available && !b.blockedReason
  );
  // While the preview step exists but hasn't reached a terminal status, keep
  // waiting on it — don't flash the lower-quality polyGen `thumbnail` and make
  // the card look done. Only fall back to the polyGen thumbnail once the
  // preview step is terminal (failed/expired/canceled/succeeded) or absent.
  const previewPending =
    !!previewStep &&
    (!previewStep.status || !orchestratorCompletedStatuses.includes(previewStep.status));
  const thumbnailUrl =
    previewImage?.previewUrl ??
    previewImage?.url ??
    (previewPending ? null : blob?.thumbnailUrl) ??
    null;

  // GLB-only siblings the three.js viewer can mount; shared with the
  // full-screen lightbox so both render the same variant taxonomy.
  const viewableVariants: Model3DViewableVariant[] = blob ? getModel3DViewableVariants(blob) : [];

  const showSpinner = pending || processing;
  // Terminal failure states — workflow won't produce a thumbnail. The
  // orchestrator auto-refunds spent buzz on these, so surface that to the
  // user instead of the ambiguous "No preview available yet".
  const isFailed =
    request.status === 'failed' || request.status === 'expired' || request.status === 'canceled';
  const failureLabel =
    request.status === 'expired'
      ? 'Generation expired'
      : request.status === 'canceled'
      ? 'Generation canceled'
      : 'Generation failed';
  const isComplete = !pending && !processing && !isFailed;

  // Open the model full-screen. Local (non-routed) dialog, same pattern as
  // the image lightbox; the heavy three.js viewer lives inside the dialog
  // component so it only mounts when expanded.
  const handleExpand = () => {
    if (!blob) return;
    dialogStore.trigger({
      id: 'generated-model3d',
      component: Model3DLightbox,
      props: { blob },
    });
  };

  return (
    // Render inside the same responsive output grid as the image/video/audio
    // results so the 3D card occupies a single tile and sizes identically at
    // every breakpoint (and honors the largerGenerationImages sidebar layout).
    <div
      className={clsx(classes.grid, {
        [classes.asSidebar]: !features.largerGenerationImages,
      })}
    >
      <div className="flex w-full flex-col gap-2">
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
              <Tooltip label="Expand to full screen" withinPortal position="left">
                <LegacyActionIcon
                  variant="filled"
                  color="dark"
                  radius="xl"
                  size="sm"
                  aria-label="Expand 3D viewer to full screen"
                  onClick={handleExpand}
                  style={{ position: 'absolute', top: 8, right: 44, zIndex: 2 }}
                >
                  <IconArrowsMaximize size={14} stroke={2} />
                </LegacyActionIcon>
              </Tooltip>
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
              <img src={thumbnailUrl} alt="3D model thumbnail" className="size-full object-cover" />
              {modelUrl && (
                <>
                  <Tooltip label="Expand to full screen" withinPortal position="left">
                    <LegacyActionIcon
                      variant="filled"
                      color="dark"
                      radius="xl"
                      size="sm"
                      aria-label="Expand 3D viewer to full screen"
                      onClick={handleExpand}
                      style={{ position: 'absolute', top: 8, right: 44, zIndex: 2 }}
                    >
                      <IconArrowsMaximize size={14} stroke={2} />
                    </LegacyActionIcon>
                  </Tooltip>
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
                </>
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

        <Model3DOutputActions blob={blob} workflowId={request.id} isComplete={isComplete} />
      </div>
    </div>
  );
}
