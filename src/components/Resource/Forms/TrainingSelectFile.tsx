import {
  Button,
  Center,
  Flex,
  Group,
  Image,
  Loader,
  Paper,
  Progress,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { IconAlertCircle, IconArrowRight, IconFileDownload, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import dayjs from '~/shared/utils/dayjs';
import { useRouter } from 'next/router';
import React, { useRef, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';
import type { ModelWithTags } from '~/components/Resource/Wizard/ModelWizard';
import { GenerateButton } from '~/components/RunStrategy/GenerateButton';
import { SubscriptionRequiredBlock } from '~/components/Subscriptions/SubscriptionRequiredBlock';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { canGenerateWithEpoch } from '~/server/common/model-helpers';
import type { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import type { ModelVersionUpsertInput } from '~/server/schema/model-version.schema';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
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
  loading,
  incomplete,
  modelVersionId,
  canGenerate,
  isVideo,
}: {
  epoch: TrainingResultsV2['epochs'][number];
  prompts: TrainingResultsV2['sampleImagesPrompts'];
  selectedFile: string | undefined;
  setSelectedFile: React.Dispatch<React.SetStateAction<string | undefined>>;
  onPublishClick: (modelUrl: string) => void;
  loading?: boolean;
  incomplete?: boolean;
  modelVersionId: number;
  canGenerate?: boolean;
  isVideo: boolean;
}) => {
  const currentUser = useCurrentUser();
  // const features = useFeatureFlags();

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
        <Group justify="space-between" className={classes.epochRow}>
          <Text fz="md" fw={700}>
            Epoch #{epoch.epochNumber}
          </Text>
          <Group gap={8} wrap="nowrap">
            <DownloadButton
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              component="a"
              canDownload
              href={epoch.modelUrl}
              variant="light"
            >
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
                  canGenerate={true}
                  disabled={!currentUser?.isMember && !currentUser?.isModerator}
                  epochNumber={epoch.epochNumber}
                />
              </SubscriptionRequiredBlock>
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

  const modelFile = modelVersion.files.find((f) => f.type === 'Training Data');
  const existingModelFile = modelVersion.files.find((f) => f.type === 'Model');
  const trainingResults = modelFile?.metadata?.trainingResults;
  const isVideo = modelVersion.trainingDetails?.mediaType === 'video';

  const [selectedFile, setSelectedFile] = useState<string | undefined>(
    existingModelFile?.metadata?.selectedEpochUrl
  );
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    current: number;
    total: number;
    epochNumber: number;
    fileProgress: number; // 0-100 for current file
  } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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

  const errorMessage =
    modelVersion.trainingStatus === TrainingStatus.Paused
      ? 'Your training will resume or terminate within 1 business day. No action is required on your part.'
      : modelVersion.trainingStatus === TrainingStatus.Failed
      ? 'The training job failed. You can still access any completed epochs below, or contact us for help.'
      : modelVersion.trainingStatus === TrainingStatus.Denied
      ? 'The training job was denied for violating the TOS. Please contact us with any questions.'
      : undefined;
  const noEpochs = !epochs || !epochs.length;
  // Allow access to epochs for failed trainings if epochs exist
  const hasFailedWithEpochs = modelVersion.trainingStatus === TrainingStatus.Failed && !noEpochs;
  const resultsLoading =
    (modelVersion.trainingStatus !== TrainingStatus.InReview &&
      modelVersion.trainingStatus !== TrainingStatus.Approved &&
      !hasFailedWithEpochs) ||
    noEpochs;

  const cancelDownload = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  };

  const downloadAll = async () => {
    if (noEpochs || downloading) return;

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;

    // Create new AbortController for this download session
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const downloadWithProgress = async (
      url: string,
      epochNumber: number,
      currentIndex: number,
      total: number
    ): Promise<Blob> => {
      const response = await fetch(url, { signal: abortController.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentLength = response.headers.get('content-length');
      const totalSize = contentLength ? parseInt(contentLength, 10) : 0;

      // If no content-length header, fall back to simple blob download
      if (!totalSize || !response.body) {
        setDownloadProgress({ current: currentIndex, total, epochNumber, fileProgress: 50 });
        return response.blob();
      }

      // Stream the response and track progress
      const reader = response.body.getReader();
      const chunks: BlobPart[] = [];
      let receivedLength = 0;

      try {
        while (true) {
          // Check for cancellation during streaming
          if (abortController.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }

          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          receivedLength += value.length;

          const fileProgress = Math.round((receivedLength / totalSize) * 100);
          setDownloadProgress({ current: currentIndex, total, epochNumber, fileProgress });
        }
      } finally {
        reader.releaseLock();
      }

      return new Blob(chunks);
    };

    const downloadWithRetry = async (
      epochData: (typeof epochs)[number],
      currentIndex: number,
      total: number
    ): Promise<boolean> => {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // Check for cancellation before starting
        if (abortController.signal.aborted) {
          return false;
        }

        try {
          setDownloadProgress({
            current: currentIndex,
            total,
            epochNumber: epochData.epochNumber,
            fileProgress: 0,
          });

          const blob = await downloadWithProgress(
            epochData.modelUrl,
            epochData.epochNumber,
            currentIndex,
            total
          );

          // Check for cancellation after download
          if (abortController.signal.aborted) {
            return false;
          }

          // Create object URL for download with custom filename
          const blobUrl = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = blobUrl;
          link.download = `${model.name}_epoch_${epochData.epochNumber}.safetensors`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(blobUrl);

          return true;
        } catch (error) {
          // Don't retry if aborted
          if (error instanceof DOMException && error.name === 'AbortError') {
            return false;
          }

          const isLastAttempt = attempt === MAX_RETRIES;
          if (isLastAttempt) {
            showErrorNotification({
              title: `Failed to download epoch ${epochData.epochNumber}`,
              error: error instanceof Error ? error : new Error('Unknown error'),
              autoClose: false,
            });
            return false;
          }
          // Wait before retrying with exponential backoff
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        }
      }
      return false;
    };

    setDownloading(true);
    setDownloadProgress({ current: 0, total: epochs.length, epochNumber: 0, fileProgress: 0 });

    for (let i = 0; i < epochs.length; i++) {
      // Check for cancellation before each file
      if (abortController.signal.aborted) {
        break;
      }
      await downloadWithRetry(epochs[i], i + 1, epochs.length);
    }

    setDownloading(false);
    setDownloadProgress(null);
    abortControllerRef.current = null;
  };

  const canGenerateWithEpochBool = canGenerateWithEpoch(completeDate);

  // Only show blocking error for Paused, Denied, or Failed without epochs
  const showBlockingError = !!errorMessage && !hasFailedWithEpochs;

  return (
    <Stack>
      {showBlockingError ? (
        <Stack p="xl" align="center">
          <IconAlertCircle size={52} />
          <Text>{errorMessage}</Text>
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
          <Stack gap="xs">
            <Flex justify="flex-end" align="center" gap="md">
              {downloadProgress && (
                <Text size="sm" c="dimmed">
                  Downloading epoch {downloadProgress.epochNumber} ({downloadProgress.current}/
                  {downloadProgress.total}) - {downloadProgress.fileProgress}%
                </Text>
              )}
              {downloading ? (
                <Button
                  color="red"
                  variant="light"
                  leftSection={<IconX size={18} />}
                  onClick={cancelDownload}
                >
                  Cancel
                </Button>
              ) : (
                <Button
                  color="cyan"
                  leftSection={<IconFileDownload size={18} />}
                  onClick={downloadAll}
                >
                  Download All ({epochs.length})
                </Button>
              )}
            </Flex>
            {downloadProgress && (
              <Progress.Root size="sm">
                <Progress.Section
                  value={
                    ((downloadProgress.current - 1) / downloadProgress.total) * 100 +
                    downloadProgress.fileProgress / downloadProgress.total
                  }
                  color="cyan"
                />
              </Progress.Root>
            )}
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
            loading={awaitInvalidate}
            incomplete={resultsLoading}
            modelVersionId={modelVersion.id}
            canGenerate={features.privateModels && !!modelVersion.id && canGenerateWithEpochBool}
            isVideo={isVideo}
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
                  loading={awaitInvalidate}
                  incomplete={resultsLoading}
                  modelVersionId={modelVersion.id}
                  canGenerate={
                    features.privateModels && !!modelVersion.id && canGenerateWithEpochBool
                  }
                  isVideo={isVideo}
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
