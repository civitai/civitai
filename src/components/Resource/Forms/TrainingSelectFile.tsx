import {
  Button,
  Center,
  createStyles,
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
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { IconAlertCircle, IconFileDownload, IconSend } from '@tabler/icons-react';
import { saveAs } from 'file-saver';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';
import { ModelWithTags } from '~/components/Resource/Wizard/ModelWizard';
import { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import { ModelVersionUpsertInput } from '~/server/schema/model-version.schema';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
import { ModelVersionById } from '~/types/router';
import { getModelFileFormat } from '~/utils/file-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { bytesToKB, formatKBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  epochRow: {
    [containerQuery.smallerThan('sm')]: {
      flexDirection: 'column',
      gap: theme.spacing.md,
    },
  },
  selectedRow: {
    border: `2px solid ${theme.fn.rgba(theme.colors.green[5], 0.7)}`,
  },
  paperRow: {
    cursor: 'pointer',
    '&:hover': {
      backgroundColor: theme.fn.rgba(theme.colors.blue[2], 0.1),
    },
  },
}));

const TRANSMITTER_KEY = 'trainer';

const EpochRow = ({
  epoch,
  prompts,
  selectedFile,
  setSelectedFile,
  onPublishClick,
  loading,
  incomplete,
}: {
  epoch: TrainingResultsV2['epochs'][number];
  prompts: TrainingResultsV2['sampleImagesPrompts'];
  selectedFile: string | undefined;
  setSelectedFile: React.Dispatch<React.SetStateAction<string | undefined>>;
  onPublishClick: (modelUrl: string) => void;
  loading?: boolean;
  incomplete?: boolean;
}) => {
  const { classes, cx } = useStyles();

  return (
    <Paper
      shadow="sm"
      radius="sm"
      p="xs"
      withBorder
      className={cx(
        classes.paperRow,
        selectedFile === epoch.modelUrl ? classes.selectedRow : undefined
      )}
      onClick={() => setSelectedFile(epoch.modelUrl)}
    >
      <Stack>
        <Group position="apart" className={classes.epochRow}>
          <Text fz="md" fw={700}>
            Epoch #{epoch.epochNumber}
          </Text>
          <Group spacing={8} noWrap>
            <DownloadButton
              onClick={(e) => e.stopPropagation()}
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
            <Button
              disabled={incomplete}
              loading={loading}
              onClick={() => onPublishClick(epoch.modelUrl)}
            >
              <Group spacing={4} noWrap>
                <IconSend size={20} />
                Publish
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
                <Image
                  alt={`Sample image #${index}`}
                  src={url}
                  withPlaceholder
                  imageProps={{
                    style: {
                      height: '200px',
                      // if we want to show full image, change objectFit to contain
                      objectFit: 'cover',
                      // object-position: top;
                      width: '100%',
                    },
                  }}
                />
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
  const queryUtils = trpc.useUtils();
  const router = useRouter();

  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);

  const modelFile = modelVersion.files.find((f) => f.type === 'Training Data');
  const existingModelFile = modelVersion.files.find((f) => f.type === 'Model');
  const trainingResults = modelFile?.metadata?.trainingResults;

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
        trainedWords: [],
        // ---
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
  } else {
    epochs =
      trainingResults.epochs?.map((e) => ({
        epochNumber: e.epoch_number,
        modelUrl: e.model_url,
        modelSize: 0,
        sampleImages: e.sample_images?.map((s) => s.image_url) ?? [],
      })) ?? [];
    samplePrompts = trainingResults.epochs?.[0]?.sample_images?.map((s) => s.prompt) ?? [];
  }
  epochs = epochs.toSorted((a, b) => b.epochNumber - a.epochNumber);

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
          <Stack spacing="sm" align="center">
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
              <Stack spacing="sm" align="center">
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
          <Flex justify="flex-end">
            <Button
              color="cyan"
              loading={downloading}
              leftIcon={<IconFileDownload size={18} />}
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
                />
              ))}
            </>
          )}
        </>
      )}

      <Group mt="xl" position="right">
        <Button onClick={() => handleSubmit()} disabled={resultsLoading} loading={awaitInvalidate}>
          Next
        </Button>
      </Group>
    </Stack>
  );
}
