import {
  Button,
  Center,
  Flex,
  Group,
  Image,
  Loader,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { IconAlertCircle, IconArrowRight, IconFileDownload } from '@tabler/icons-react';
import clsx from 'clsx';
import dayjs from '~/shared/utils/dayjs';
import { saveAs } from 'file-saver';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
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
  if (!model || !modelVersion || !modelFile) {
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
      ? 'The training job failed. Please recreate this model and try again, or contact us for help.'
      : modelVersion.trainingStatus === TrainingStatus.Denied
      ? 'The training job was denied for violating the TOS. Please contact us with any questions.'
      : undefined;
  const noEpochs = !epochs || !epochs.length;
  const resultsLoading =
    (modelVersion.trainingStatus !== TrainingStatus.InReview &&
      modelVersion.trainingStatus !== TrainingStatus.Approved) ||
    noEpochs;

  const downloadAll = async () => {
    if (noEpochs) return;

    setDownloading(true);

    await Promise.all(
      epochs.map(async (epochData) => {
        const epochBlob = await fetch(epochData.modelUrl).then((res) => res.blob());
        saveAs(epochBlob, `${model.name}_epoch_${epochData.epochNumber}.safetensors`);
      })
    );

    setDownloading(false);
  };

  const canGenerateWithEpochBool = canGenerateWithEpoch(completeDate);

  return (
    <Stack>
      {!!errorMessage ? (
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
          <Flex justify="flex-end">
            <Button
              color="cyan"
              loading={downloading}
              leftSection={<IconFileDownload size={18} />}
              onClick={downloadAll}
            >
              Download All ({epochs.length})
            </Button>
          </Flex>
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
