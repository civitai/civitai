import {
  ActionIcon,
  Button,
  Center,
  Flex,
  Group,
  Image,
  Loader,
  Menu,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowRight,
  IconBrush,
  IconDotsVertical,
  IconFileDownload,
  IconRepeat,
} from '@tabler/icons-react';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import clsx from 'clsx';
import dayjs from '~/shared/utils/dayjs';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';
import type { ModelWithTags } from '~/components/Resource/Wizard/ModelWizard';
import { GenerateButton } from '~/components/RunStrategy/GenerateButton';
import { SubscriptionRequiredBlock } from '~/components/Subscriptions/SubscriptionRequiredBlock';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { canGenerateWithEpoch } from '~/server/common/model-helpers';
import { pickBestTrainingFile, type TrainingResultsV2 } from '~/server/schema/model-file.schema';
import type { ModelFileCreateInput } from '~/server/schema/model-file.schema';
import type {
  ModelVersionUpsertInput,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import { getEpochJobAndFileName } from '~/server/utils/model-helpers';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { stringifyAIR } from '~/shared/utils/air';
import { ModelType, ModelUploadType, TrainingStatus } from '~/shared/utils/prisma/enums';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
import { getDefaultTrainingParams, trainingStore } from '~/store/training.store';
import { basePath as trainWizardBasePath } from '~/components/Training/Form/TrainingCommon';
import {
  AI_TOOLKIT_EPOCHS,
  aiToolkitStepDefault,
  aiToolkitSaveEveryDefault,
  type TrainingBaseModelType,
} from '~/utils/training';
import type { ModelVersionById } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { getModelFileFormat } from '~/utils/file-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { bytesToKB, formatKBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import classes from './TrainingSelectFile.module.css';

const TRANSMITTER_KEY = 'trainer';

const EpochRow = ({
  epoch,
  prompts,
  selectedFile,
  setSelectedFile,
  onPublishClick,
  onContinueTraining,
  continueLoading,
  loading,
  incomplete,
  modelId,
  modelVersionId,
  canGenerate,
  isVideo,
  modelName,
}: {
  epoch: TrainingResultsV2['epochs'][number];
  prompts: TrainingResultsV2['sampleImagesPrompts'];
  selectedFile: string | undefined;
  setSelectedFile: React.Dispatch<React.SetStateAction<string | undefined>>;
  onPublishClick: (modelUrl: string) => void;
  /** Steps-pricing (AI Toolkit only): start a new training run continuing from this epoch. */
  onContinueTraining?: (epoch: TrainingResultsV2['epochs'][number]) => void;
  continueLoading?: boolean;
  loading?: boolean;
  incomplete?: boolean;
  modelId: number;
  modelVersionId: number;
  canGenerate?: boolean;
  isVideo: boolean;
  modelName: string;
}) => {
  const currentUser = useCurrentUser();
  // On small containers the 4 labeled actions overflow the card, so collapse the
  // secondary ones (Download/Generate/Train Further) into a ⋯ menu next to Continue.
  const isMobile = useIsMobile();

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Use direct navigation so the browser streams to disk without buffering in memory
    const link = document.createElement('a');
    link.href = `/api/download/training/${modelVersionId}?epochNumber=${epoch.epochNumber}`;
    link.download = `${modelName}_epoch_${epoch.epochNumber}.safetensors`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <Paper
      shadow="sm"
      radius="sm"
      p="xs"
      withBorder
      className={clsx(
        classes.paperRow,
        selectedFile === epoch.modelUrl ? classes.selectedRow : undefined
      )}
      onClick={() => setSelectedFile(epoch.modelUrl)}
    >
      <Stack>
        <Group justify="space-between" wrap="nowrap">
          <Text fz="md" fw={700} style={{ flexShrink: 0 }}>
            Epoch #{epoch.epochNumber}
          </Text>
          {isMobile ? (
            <Group gap={8} wrap="nowrap">
              <Button
                disabled={incomplete}
                loading={loading}
                onClick={() => onPublishClick(epoch.modelUrl)}
              >
                <Group gap={4} wrap="nowrap">
                  Continue
                  <IconArrowRight size={20} />
                </Group>
              </Button>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon
                    size="lg"
                    variant="light"
                    aria-label="More epoch actions"
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  >
                    <IconDotsVertical size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item leftSection={<IconFileDownload size={16} />} onClick={handleDownload}>
                    {epoch.modelSize > 0
                      ? `Download (${formatKBytes(bytesToKB(epoch.modelSize))})`
                      : 'Download'}
                  </Menu.Item>
                  {canGenerate && (
                    <SubscriptionRequiredBlock feature="private-models">
                      <GenerateButton
                        versionId={modelVersionId}
                        modelId={modelId}
                        epochNumber={epoch.epochNumber}
                        data-activity="create:training-select"
                      >
                        <Menu.Item
                          leftSection={<IconBrush size={16} />}
                          disabled={!currentUser?.isMember && !currentUser?.isModerator}
                        >
                          Generate
                        </Menu.Item>
                      </GenerateButton>
                    </SubscriptionRequiredBlock>
                  )}
                  {!!onContinueTraining && (
                    <Menu.Item
                      leftSection={<IconRepeat size={16} />}
                      c="violet"
                      disabled={continueLoading}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onContinueTraining(epoch);
                      }}
                    >
                      Train Further
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            </Group>
          ) : (
            <Group gap={8} wrap="nowrap">
              <DownloadButton onClick={handleDownload} canDownload variant="light">
                <Text align="center">
                  {epoch.modelSize > 0
                    ? `Download (${formatKBytes(bytesToKB(epoch.modelSize))})`
                    : 'Download'}
                </Text>
              </DownloadButton>
              {canGenerate && (
                <SubscriptionRequiredBlock feature="private-models">
                  {/* TODO will this work? */}
                  <GenerateButton
                    versionId={modelVersionId}
                    modelId={modelId}
                    disabled={!currentUser?.isMember && !currentUser?.isModerator}
                    epochNumber={epoch.epochNumber}
                    data-activity="create:training-select"
                  />
                </SubscriptionRequiredBlock>
              )}
              {!!onContinueTraining && (
                <Tooltip
                  label="Start a new training run that picks up from this epoch instead of the base model"
                  withArrow
                  multiline
                  maw={250}
                >
                  <Button
                    variant="light"
                    color="violet"
                    loading={continueLoading}
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      onContinueTraining(epoch);
                    }}
                  >
                    <Group gap={4} wrap="nowrap">
                      <IconRepeat size={18} />
                      Train Further
                    </Group>
                  </Button>
                </Tooltip>
              )}
              <Button
                disabled={incomplete}
                loading={loading}
                onClick={() => onPublishClick(epoch.modelUrl)}
              >
                <Group gap={4} wrap="nowrap">
                  Continue
                  <IconArrowRight size={20} />
                </Group>
              </Button>
            </Group>
          )}
        </Group>
        <Group
          className={classes.epochRow}
          style={{ justifyContent: 'space-evenly', alignItems: 'flex-start' }}
        >
          {epoch.sampleImages && epoch.sampleImages.length > 0 ? (
            epoch.sampleImages.map((url, index) => (
              <Stack key={index} style={{ justifyContent: 'flex-start' }}>
                {isVideo ? (
                  <video
                    loop
                    playsInline
                    disablePictureInPicture
                    muted
                    autoPlay
                    controls={false}
                    height={200}
                    // width={180}
                    className="w-full object-cover"
                  >
                    <source src={url} type="video/mp4" />
                  </video>
                ) : (
                  <Image
                    alt={`Sample image #${index}`}
                    src={url}
                    style={{
                      height: '200px',
                      // if we want to show full image, change objectFit to contain
                      objectFit: 'cover',
                      // object-position: top;
                      width: '100%',
                    }}
                  />
                )}
                <Textarea
                  autosize
                  minRows={1}
                  maxRows={4}
                  value={prompts[index] || '(no prompt provided)'}
                  readOnly
                />
              </Stack>
            ))
          ) : (
            <Center p="md">
              <Text>No images available</Text>
            </Center>
          )}
        </Group>
      </Stack>
    </Paper>
  );
};

// Read-only list of the sample-image prompts the user configured for this training.
// Surfaced when a training fails before any epoch completes so the prompts (which are
// still saved server-side) remain recoverable without inspecting the page source.
const SamplePromptsPanel = ({ prompts }: { prompts: string[] }) => {
  const nonEmptyPrompts = prompts.filter((p) => p.trim().length > 0);
  if (!nonEmptyPrompts.length) return null;

  return (
    <Paper p="md" radius="md" withBorder className="w-full max-w-2xl">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>Your saved sample prompts</Text>
        <CopyButton value={nonEmptyPrompts.join('\n')}>
          {({ copy, copied, Icon, color }) => (
            <Tooltip label={copied ? 'Copied' : 'Copy all prompts'} withArrow>
              <Button
                size="compact-sm"
                variant="light"
                color={color}
                leftSection={<Icon size={16} />}
                onClick={copy}
              >
                Copy all
              </Button>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        The training failed before any sample images were generated, but these are the prompts you
        configured. You can copy them to reuse if you submit the training again.
      </Text>
      <ScrollArea.Autosize mah={260}>
        <Stack gap="xs">
          {nonEmptyPrompts.map((prompt, index) => (
            <Group key={index} gap="xs" align="flex-start" wrap="nowrap">
              <CopyButton value={prompt}>
                {({ copy, copied, Icon, color }) => (
                  <Tooltip label={copied ? 'Copied' : 'Copy prompt'} withArrow>
                    <ActionIcon variant="subtle" color={color} onClick={copy} mt={4}>
                      <Icon size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
              <Textarea
                className="flex-1"
                autosize
                minRows={1}
                maxRows={4}
                value={prompt}
                readOnly
              />
            </Group>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Paper>
  );
};

export default function TrainingSelectFile({
  model,
  modelVersion,
  onNextClick,
}: {
  model: ModelWithTags | ModelVersionById['model'];
  modelVersion: ModelWithTags['modelVersions'][number] | ModelVersionById;
  onNextClick: () => void;
}) {
  const features = useFeatureFlags();
  const queryUtils = trpc.useUtils();
  const router = useRouter();

  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);

  const trainingDataFiles = modelVersion.files.filter((f) => f.type === 'Training Data');
  const modelFile = pickBestTrainingFile(trainingDataFiles);
  const existingModelFile = modelVersion.files.find((f) => f.type === 'Model');
  const trainingResults = modelFile?.metadata?.trainingResults;
  const isVideo = modelVersion.trainingDetails?.mediaType === 'video';

  const [selectedFile, setSelectedFile] = useState<string | undefined>(
    existingModelFile?.metadata?.selectedEpochUrl
  );
  const [downloading, setDownloading] = useState(false);

  const upsertFileMutation = trpc.modelFile.upsert.useMutation({
    async onSuccess() {
      const versionMutateData: ModelVersionUpsertInput = {
        id: modelVersion.id,
        modelId: model.id,
        name: modelVersion.name,
        baseModel: modelVersion.baseModel,
        trainingStatus: TrainingStatus.Approved,
      };

      upsertVersionMutation.mutate(versionMutateData);
    },
    onError(error) {
      setAwaitInvalidate(false);
      showErrorNotification({
        title: 'Failed to create file.',
        error: new Error(error.message),
        autoClose: false,
      });
    },
  });

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation({
    onSuccess: async (vData) => {
      // TODO [bw] ideally, we would simply update the proper values rather than invalidate to skip the loading step
      await queryUtils.modelVersion.getById.invalidate({ id: vData.id });
      await queryUtils.modelVersion.getById.invalidate({ id: vData.id, withFiles: true });
      await queryUtils.modelVersion.getByIdForEdit.invalidate({ id: vData.id });
      await queryUtils.modelVersion.getByIdForEdit.invalidate({ id: vData.id, withFiles: true });
      await queryUtils.model.getById.invalidate({ id: model?.id });
      await queryUtils.model.getMyTrainingModels.invalidate();

      setAwaitInvalidate(false);
      onNextClick();
    },
    onError: (error) => {
      setAwaitInvalidate(false);
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to save model version',
        autoClose: false,
      });
    },
  });

  const moveAssetMutation = trpc.training.moveAsset.useMutation();

  // -- "Train Further" (steps-based pricing, AI Toolkit only) --------------------------
  // Starts a new training run that continues from a selected epoch: creates a new Pending
  // version under the same model, clones the training dataset file, seeds the training
  // store with `continueFrom`, and drops the user into the training wizard's submit step.
  const continueVersionMutation = trpc.modelVersion.upsert.useMutation();
  const continueFileMutation = trpc.modelFile.create.useMutation();
  const [continuingFrom, setContinuingFrom] = useState<number | undefined>();

  const thisTrainingDetails = modelVersion.trainingDetails as TrainingDetailsObj | undefined;
  const trainingEnded =
    modelVersion.trainingStatus === TrainingStatus.InReview ||
    modelVersion.trainingStatus === TrainingStatus.Approved ||
    modelVersion.trainingStatus === TrainingStatus.Failed;
  const canTrainFurther =
    features.trainingStepsPricing &&
    trainingEnded &&
    thisTrainingDetails?.params?.engine === 'ai-toolkit';

  const handleContinueTraining = async (epoch: TrainingResultsV2['epochs'][number]) => {
    if (continuingFrom !== undefined) return;
    const base = thisTrainingDetails?.baseModel;
    if (!modelFile || !thisTrainingDetails || !base) {
      showErrorNotification({
        error: new Error('Missing training data for this model version.'),
        autoClose: false,
      });
      return;
    }
    setContinuingFrom(epoch.epochNumber);

    try {
      const mediaType = thisTrainingDetails.mediaType ?? 'image';
      // 'sd15' matches the server-side default in createTrainingWorkflow for versions
      // that predate baseModelType.
      const baseType = (thisTrainingDetails.baseModelType ?? 'sd15') as TrainingBaseModelType;

      // The orchestrator expects `continueFrom` as an AIR referencing the LoRA — the same
      // orchestrator-sourced AIR generation builds for epoch resources — not a file URL.
      const epochJobFile = getEpochJobAndFileName(epoch.modelUrl);
      if (!epochJobFile) {
        throw new Error('Could not resolve a resource reference for this epoch.');
      }
      const continueFromAir = stringifyAIR({
        baseModel: modelVersion.baseModel,
        type: (model as { type?: ModelType }).type ?? ModelType.LORA,
        modelId: epochJobFile.jobId,
        id: epochJobFile.fileName,
        source: 'orchestrator',
      });

      // Same shape TrainingBasicInfo creates, so the training wizard treats the new
      // version as the active (Pending) one.
      const versionData: ModelVersionUpsertInput = {
        modelId: model.id,
        name: `${modelVersion.name} (from epoch ${epoch.epochNumber})`,
        baseModel: modelVersion.baseModel as BaseModel,
        trainedWords: (modelVersion as { trainedWords?: string[] }).trainedWords ?? [],
        trainingStatus: TrainingStatus.Pending,
        trainingDetails: {
          type: thisTrainingDetails.type,
          mediaType,
          baseModel: base,
          baseModelType: thisTrainingDetails.baseModelType,
          continueFromEpoch: {
            air: continueFromAir,
            epochNumber: epoch.epochNumber,
            sourceModelVersionId: modelVersion.id,
            sourceVersionName: modelVersion.name,
          },
        },
        uploadType: ModelUploadType.Trained,
      };
      const newVersion = await continueVersionMutation.mutateAsync(versionData);

      // Clone the dataset file onto the new version. Drop trainingResults from the copied
      // metadata — those belong to the source run and would pollute the new run's epoch
      // list until the orchestrator webhook overwrites them.
      const { trainingResults: _omit, ...cleanMetadata } = (modelFile.metadata ??
        {}) as FileMetadata;
      const fileData: ModelFileCreateInput = {
        name: `${newVersion.id}_training_data.zip`,
        url: modelFile.url,
        sizeKB: modelFile.sizeKB,
        type: 'Training Data',
        modelVersionId: newVersion.id,
        visibility: modelFile.visibility,
        metadata: cleanMetadata,
      };
      await continueFileMutation.mutateAsync(fileData);

      // Seed the submit form: steps-pricing defaults + continueFrom, reusing the source
      // run's base model and prompts. "Save every" seeds to ~10 checkpoints; maxTrainEpochs
      // (sent as `epochs`) is derived from it in the submit form.
      const params = getDefaultTrainingParams(base, 'ai-toolkit');
      params.engine = 'ai-toolkit';
      params.trainBatchSize = 1;
      params.targetSteps = aiToolkitStepDefault(baseType);
      params.saveEvery = aiToolkitSaveEveryDefault(params.targetSteps);
      params.maxTrainEpochs = AI_TOOLKIT_EPOCHS.default;
      params.continueFrom = continueFromAir;

      trainingStore.resetRuns(model.id, mediaType);
      trainingStore.updateRun(model.id, mediaType, 1, {
        base,
        baseType,
        params,
        ...(thisTrainingDetails.samplePrompts?.length && {
          samplePrompts: thisTrainingDetails.samplePrompts,
        }),
        ...(thisTrainingDetails.negativePrompt && {
          negativePrompt: thisTrainingDetails.negativePrompt,
        }),
      });

      await queryUtils.training.getModelBasic.invalidate({ id: model.id });
      // Explicit version handoff — the train wizard pins this version rather than
      // assuming the newest one is the active training.
      await router.push(
        `${trainWizardBasePath}?modelId=${model.id}&modelVersionId=${newVersion.id}&step=3`
      );
    } catch (e) {
      const error = e as Error;
      showErrorNotification({
        title: 'Failed to start continued training',
        error: new Error(error.message),
        autoClose: false,
      });
      setContinuingFrom(undefined);
    }
  };

  const handleSubmit = async (overrideFile?: string) => {
    const fileUrl = overrideFile || selectedFile;
    if (!fileUrl || !fileUrl.length) {
      showErrorNotification({
        error: new Error('Please select a file to be used.'),
        autoClose: false,
      });
      return;
    }

    if (fileUrl === existingModelFile?.metadata?.selectedEpochUrl) {
      onNextClick();
      return;
    }

    setAwaitInvalidate(true);

    const publishImages =
      trainingResults?.version === 2
        ? (trainingResults?.epochs ?? []).find((e) => e.modelUrl === fileUrl)?.sampleImages
        : (trainingResults?.epochs ?? [])
            .find((e) => e.model_url === fileUrl)
            ?.sample_images?.map((si) => si.image_url);

    if (publishImages?.length) {
      orchestratorMediaTransmitter.setUrls(
        TRANSMITTER_KEY,
        publishImages.map((url) => ({ url }))
      );

      await router.replace({ query: { ...router.query, src: TRANSMITTER_KEY } }, undefined, {
        shallow: true,
        scroll: false,
      });
    }

    moveAssetMutation.mutate(
      {
        url: fileUrl,
        modelVersionId: modelVersion.id,
      },
      {
        onSuccess: (data) => {
          upsertFileMutation.mutate({
            ...(existingModelFile && { id: existingModelFile.id }),
            url: data.newUrl,
            name: data.newUrl.split('/').pop() ?? 'model-file',
            sizeKB: bytesToKB(data.fileSize ?? 0),
            modelVersionId: modelVersion.id,
            type: 'Model',
            metadata: {
              format: getModelFileFormat(data.newUrl),
              selectedEpochUrl: fileUrl,
            },
          });
        },
        onError: (error) => {
          setAwaitInvalidate(false);
          showErrorNotification({
            title: 'Failed to create file.',
            error: new Error(error.message),
            autoClose: false,
          });
        },
      }
    );
  };

  // you should only be able to get to this screen after having created a model, version, and uploading a training set
  if (!model || !modelVersion) {
    return <NotFound />;
  }

  // Check if training files have been purged (completed training but no training data file)
  const trainingCompleted =
    modelVersion.trainingStatus === TrainingStatus.InReview ||
    modelVersion.trainingStatus === TrainingStatus.Approved ||
    modelVersion.trainingStatus === TrainingStatus.Failed;

  if (!modelFile && trainingCompleted) {
    return (
      <Stack p="xl" align="center" gap="md">
        <IconAlertCircle size={52} color="var(--mantine-color-yellow-6)" />
        <Title order={3}>Training Files Expired</Title>
        <Text ta="center" maw={500}>
          Your training files have been automatically removed after 30 days. This includes all epoch
          files and sample images. If you haven&apos;t published your model yet, you&apos;ll need to
          start a new training run.
        </Text>
        <Text ta="center" c="dimmed" size="sm">
          To avoid this in the future, make sure to publish or download your trained model within 30
          days of completion.
        </Text>
      </Stack>
    );
  }

  if (!modelFile) {
    return <NotFound />;
  }

  let epochs: TrainingResultsV2['epochs'];
  let samplePrompts: string[];
  let completeDate: string | null | undefined | Date;

  if (!trainingResults) {
    epochs = [];
    samplePrompts = [];
  } else if (
    trainingResults.version === 2 ||
    !!(trainingResults as unknown as TrainingResultsV2).transactionData
  ) {
    // TODO this and the above is a hack for when version is missing when it shouldn't be
    const tResults = trainingResults as unknown as TrainingResultsV2;
    epochs = tResults.epochs ?? [];
    samplePrompts = tResults.sampleImagesPrompts ?? [];
    completeDate = tResults.completedAt;
  } else {
    epochs =
      trainingResults.epochs?.map((e) => ({
        epochNumber: e.epoch_number,
        modelUrl: e.model_url,
        modelSize: 0,
        sampleImages: e.sample_images?.map((s) => s.image_url) ?? [],
      })) ?? [];
    samplePrompts = trainingResults.epochs?.[0]?.sample_images?.map((s) => s.prompt) ?? [];
    completeDate = trainingResults.end_time;
  }
  epochs = [...epochs].sort((a, b) => b.epochNumber - a.epochNumber);

  // Check if epoch images may be blurred due to buzz type.
  // Images are blurred when paid with green buzz or blue buzz without a membership.
  // Images are NOT blurred when paid with yellow buzz or blue buzz with a membership.
  const tResultsV2 =
    trainingResults?.version === 2 ||
    !!(trainingResults as unknown as TrainingResultsV2)?.transactionData
      ? (trainingResults as unknown as TrainingResultsV2)
      : undefined;
  const buzzType = tResultsV2?.transactionData?.find((t) => t.accountType)?.accountType;
  console.log({ tResultsV2, buzzType });
  // Show alert when NOT paid with yellow buzz (yellow is the only type that guarantees no blur)
  const epochImagesMayBeBlurred = buzzType !== 'yellow';

  const errorMessage =
    modelVersion.trainingStatus === TrainingStatus.Paused
      ? 'Your training will resume or terminate within 1 business day. No action is required on your part.'
      : modelVersion.trainingStatus === TrainingStatus.Failed
      ? 'The training job failed. You can still access any completed epochs below, or contact us for help.'
      : modelVersion.trainingStatus === TrainingStatus.Denied
      ? 'The training job was denied for violating the TOS. Please contact us with any questions.'
      : modelVersion.trainingStatus === TrainingStatus.Expired
      ? 'The training data review was not completed in time. Please submit your training again.'
      : undefined;
  const noEpochs = !epochs || !epochs.length;
  // Allow access to epochs for failed trainings if epochs exist
  const hasFailedWithEpochs = modelVersion.trainingStatus === TrainingStatus.Failed && !noEpochs;
  const resultsLoading =
    (modelVersion.trainingStatus !== TrainingStatus.InReview &&
      modelVersion.trainingStatus !== TrainingStatus.Approved &&
      !hasFailedWithEpochs) ||
    noEpochs;

  const downloadAll = async () => {
    if (noEpochs || downloading) return;

    setDownloading(true);

    // Trigger browser-native downloads sequentially with a small delay
    // so the browser can handle multiple concurrent downloads to disk
    for (let i = 0; i < epochs.length; i++) {
      const epochData = epochs[i];
      const link = document.createElement('a');
      link.href = `/api/download/training/${modelVersion.id}?epochNumber=${epochData.epochNumber}`;
      link.download = `${model.name}_epoch_${epochData.epochNumber}.safetensors`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Small delay between downloads to avoid browser throttling
      if (i < epochs.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    setDownloading(false);
  };

  const canGenerateWithEpochBool = canGenerateWithEpoch(completeDate);

  // Only show blocking error for Paused, Denied, or Failed without epochs
  const showBlockingError = !!errorMessage && !hasFailedWithEpochs;

  // When a training fails before completing a single epoch, the user's configured sample
  // prompts are still saved server-side but are otherwise only visible in the page source.
  // Surface them so they can be copied/reused (Freshdesk #66457).
  const showFailedSamplePrompts =
    modelVersion.trainingStatus === TrainingStatus.Failed &&
    noEpochs &&
    samplePrompts.some((p) => p.trim().length > 0);

  return (
    <Stack>
      {showBlockingError ? (
        <Stack p="xl" align="center">
          <IconAlertCircle size={52} />
          <Text>{errorMessage}</Text>
          {showFailedSamplePrompts && <SamplePromptsPanel prompts={samplePrompts} />}
        </Stack>
      ) : noEpochs ? (
        <Stack p="xl" align="center">
          <Loader />
          <Stack gap="sm" align="center">
            <Text>
              Models are currently training{' '}
              {modelVersion.trainingDetails?.params?.maxTrainEpochs
                ? `(0/${modelVersion.trainingDetails.params.maxTrainEpochs})`
                : '...'}
            </Text>
            <Text>Results will stream in as they complete.</Text>
          </Stack>
        </Stack>
      ) : (
        <>
          {modelVersion.trainingStatus === TrainingStatus.Processing && (
            <Stack p="xl" align="center">
              <Loader />
              <Stack gap="sm" align="center">
                <Text>
                  Models are currently training{' '}
                  {modelVersion.trainingDetails?.params?.maxTrainEpochs
                    ? `(${epochs[0]?.epochNumber ?? 0}/${
                        modelVersion.trainingDetails.params.maxTrainEpochs
                      })`
                    : '...'}
                </Text>
                <Text>Results will stream in as they complete.</Text>
              </Stack>
            </Stack>
          )}
          {hasFailedWithEpochs && (
            <DismissibleAlert
              id={`training-failed-with-epochs-${modelVersion.id}`}
              color="red"
              title="Training Failed"
            >
              <Text size="sm">
                The training job failed, but {epochs.length} epoch
                {epochs.length > 1 ? 's were' : ' was'} completed before the failure. You can still
                download or publish these completed epochs. You will receive a partial refund for
                the failed epochs.
              </Text>
            </DismissibleAlert>
          )}
          {canGenerateWithEpochBool && features.privateModels && (
            <DismissibleAlert
              id={`epoch-generation-timeout-${modelVersion.id}`}
              color="yellow"
              title="Generating with Epochs"
            >
              <Stack>
                <Text size="xs">
                  You have up to {constants.imageGeneration.epochGenerationTimeLimit} days to
                  generate with your training epochs. After that, you are required to either publish
                  the model to keep generating, or make it into a private model for yourself.
                </Text>
                <Text size="xs">
                  You have until{' '}
                  {formatDate(
                    dayjs(completeDate).add(
                      constants.imageGeneration.epochGenerationTimeLimit,
                      'day'
                    )
                  )}{' '}
                  to generate with the epochs of this model. Epoch generation is only available for
                  Civitai members.
                </Text>
              </Stack>
            </DismissibleAlert>
          )}
          {epochImagesMayBeBlurred && (
            <Paper
              p="md"
              radius="md"
              withBorder
              style={{
                borderColor: 'var(--mantine-color-yellow-6)',
                backgroundColor: 'var(--mantine-color-yellow-light)',
              }}
            >
              <Group gap="sm" wrap="nowrap" align="flex-start">
                <IconAlertTriangle
                  size={24}
                  color="var(--mantine-color-yellow-6)"
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <Stack gap={4}>
                  <Text fw={700} size="sm">
                    Why are my epoch images blurred?
                  </Text>
                  <Text size="sm">
                    {buzzType === 'green'
                      ? 'This training was submitted with Green Buzz. Epoch sample images containing mature content will appear blurred when using Green Buzz.'
                      : 'Epoch sample images containing mature content are blurred for non-members.'}{' '}
                    To get unblurred epoch images, use Yellow Buzz or Blue Buzz with a Civitai
                    Membership.
                  </Text>
                </Stack>
              </Group>
            </Paper>
          )}
          <Stack gap="xs">
            <Flex justify="flex-end" align="center" gap="md">
              <Button
                color="cyan"
                leftSection={<IconFileDownload size={18} />}
                onClick={downloadAll}
                loading={downloading}
              >
                Download All ({epochs.length})
              </Button>
            </Flex>
          </Stack>
          <Center>
            <Title order={4}>Recommended</Title>
          </Center>
          <EpochRow
            epoch={epochs[0]}
            prompts={samplePrompts}
            selectedFile={selectedFile}
            setSelectedFile={setSelectedFile}
            onPublishClick={handleSubmit}
            onContinueTraining={canTrainFurther ? handleContinueTraining : undefined}
            continueLoading={continuingFrom === epochs[0].epochNumber}
            loading={awaitInvalidate}
            incomplete={resultsLoading}
            modelId={model.id}
            modelVersionId={modelVersion.id}
            canGenerate={features.privateModels && !!modelVersion.id && canGenerateWithEpochBool}
            isVideo={isVideo}
            modelName={model.name}
          />
          {epochs.length > 1 && (
            <>
              <Center>
                <Title mt="sm" order={4}>
                  Other Results
                </Title>
              </Center>
              {epochs.slice(1).map((e, idx) => (
                <EpochRow
                  key={idx}
                  epoch={e}
                  prompts={samplePrompts}
                  selectedFile={selectedFile}
                  setSelectedFile={setSelectedFile}
                  onPublishClick={handleSubmit}
                  onContinueTraining={canTrainFurther ? handleContinueTraining : undefined}
                  continueLoading={continuingFrom === e.epochNumber}
                  loading={awaitInvalidate}
                  incomplete={resultsLoading}
                  modelId={model.id}
                  modelVersionId={modelVersion.id}
                  canGenerate={
                    features.privateModels && !!modelVersion.id && canGenerateWithEpochBool
                  }
                  isVideo={isVideo}
                  modelName={model.name}
                />
              ))}
            </>
          )}
        </>
      )}

      <Group mt="xl" justify="flex-end">
        <Button onClick={() => handleSubmit()} disabled={resultsLoading} loading={awaitInvalidate}>
          Next
        </Button>
      </Group>
    </Stack>
  );
}
