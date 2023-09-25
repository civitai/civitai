import {
  Button,
  Center,
  createStyles,
  Group,
  Image,
  Loader,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { TrainingStatus } from '@prisma/client';
import React, { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';
import { NoContent } from '~/components/NoContent/NoContent';
import { ModelWithTags } from '~/components/Resource/Wizard/ModelWizard';
import { EpochSchema } from '~/pages/api/webhooks/image-resource-training';
import { getModelFileFormat } from '~/utils/file-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { bytesToKB } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  epochRow: {
    [theme.fn.smallerThan('sm')]: {
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

const EpochRow = ({
  epoch,
  selectedFile,
  setSelectedFile,
}: {
  epoch: EpochSchema;
  selectedFile: string | undefined;
  setSelectedFile: React.Dispatch<React.SetStateAction<string | undefined>>;
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
        selectedFile === epoch.model_url ? classes.selectedRow : undefined
      )}
      onClick={() => setSelectedFile(epoch.model_url)}
    >
      <Stack>
        <Group position="apart" className={classes.epochRow}>
          <Text fz="md" fw={700}>
            Epoch #{epoch.epoch_number}
          </Text>
          <DownloadButton
            onClick={(e) => e.stopPropagation()}
            component="a"
            canDownload
            href={epoch.model_url}
            variant="light"
          >
            <Text align="center">
              {/*{`Download (${formatKBytes(modalData.file?.sizeKB)})`}*/}
              Download
            </Text>
          </DownloadButton>
        </Group>
        <Group className={classes.epochRow} style={{ justifyContent: 'space-evenly' }}>
          {epoch.sample_images && epoch.sample_images.length > 0 ? (
            epoch.sample_images.map((imgData, index) => (
              <Stack key={index} style={{ justifyContent: 'flex-start' }}>
                <Image
                  alt={`Sample image #${index}`}
                  src={imgData.image_url}
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
                <Textarea autosize minRows={1} maxRows={4} value={imgData.prompt} readOnly />
              </Stack>
            ))
          ) : (
            <Center>
              <Text>No images available.</Text>
            </Center>
          )}
        </Group>
      </Stack>
    </Paper>
  );
};

export default function TrainingSelectFile({
  model,
  onNextClick,
}: {
  model?: ModelWithTags;
  onNextClick: () => void;
}) {
  const queryUtils = trpc.useContext();
  const [awaitInvalidate, setAwaitInvalidate] = useState<boolean>(false);

  const modelVersion = model?.modelVersions?.[0];
  const modelFile = modelVersion?.files.find((f) => f.type === 'Training Data');
  const existingModelFile = modelVersion?.files.find((f) => f.type === 'Model');

  const [selectedFile, setSelectedFile] = useState<string | undefined>(
    existingModelFile?.metadata?.selectedEpochUrl
  );

  const upsertFileMutation = trpc.modelFile.upsert.useMutation({
    async onSuccess() {
      if (!model || !modelVersion) {
        // showErrorNotification({
        //   error: new Error('Missing model data. Please try again.'),
        // });
        return;
      }

      const versionMutateData = {
        id: modelVersion.id,
        modelId: model.id,
        name: model.name,
        baseModel: 'SD 1.5' as const,
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

  const handleSubmit = async () => {
    if (!model || !modelVersion) {
      showErrorNotification({
        error: new Error('Missing model data. Please try again.'),
        autoClose: false,
      });
      return;
    }
    if (!selectedFile || !selectedFile.length) {
      showErrorNotification({
        error: new Error('Please select a file to be used.'),
        autoClose: false,
      });
      return;
    }

    if (selectedFile === existingModelFile?.metadata?.selectedEpochUrl) {
      onNextClick();
      return;
    }

    setAwaitInvalidate(true);

    moveAssetMutation.mutate(
      {
        url: selectedFile,
        modelId: model.id,
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
              selectedEpochUrl: selectedFile,
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

  const epochs = [...(modelFile.metadata.trainingResults?.epochs || [])].sort(
    (a, b) => b.epoch_number - a.epoch_number
  );

  const inError = modelVersion.trainingStatus === TrainingStatus.Failed;
  const noEpochs = !epochs || !epochs.length;
  const resultsLoading =
    (modelVersion.trainingStatus !== TrainingStatus.InReview &&
      modelVersion.trainingStatus !== TrainingStatus.Approved) ||
    noEpochs;

  return (
    <Stack>
      {inError ? (
        <Center py="md">
          <NoContent message="The training job failed. Please recreate this model and try again, or contact us for help." />
        </Center>
      ) : noEpochs ? (
        <Stack p="xl" align="center">
          <Loader />
          <Stack spacing="sm" align="center">
            <Text>Models are currently training...</Text>
            <Text>Results will stream in as they complete.</Text>
          </Stack>
        </Stack>
      ) : (
        <>
          {modelVersion.trainingStatus === TrainingStatus.Processing && (
            <Stack p="xl" align="center">
              <Loader />
              <Stack spacing="sm" align="center">
                <Text>Models are currently training...</Text>
                <Text>Results will stream in as they complete.</Text>
              </Stack>
            </Stack>
          )}
          {/* TODO [bw] download all button */}
          <Center>
            <Title order={4}>Recommended</Title>
          </Center>
          <EpochRow
            epoch={epochs[0]}
            selectedFile={selectedFile}
            setSelectedFile={setSelectedFile}
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
                  selectedFile={selectedFile}
                  setSelectedFile={setSelectedFile}
                />
              ))}
            </>
          )}
        </>
      )}

      <Group mt="xl" position="right">
        {/*<Button variant="default" onClick={onBackClick}>*/}
        {/*  Back*/}
        {/*</Button>*/}
        <Button onClick={handleSubmit} disabled={resultsLoading} loading={awaitInvalidate}>
          Next
        </Button>
      </Group>
    </Stack>
  );
}
