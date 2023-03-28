import {
  ActionIcon,
  Button,
  Card,
  Group,
  Progress,
  Select,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
  Divider,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { useViewportSize } from '@mantine/hooks';
import { ModelType } from '@prisma/client';
import {
  IconBan,
  IconCircleCheck,
  IconCloudUpload,
  IconFileUpload,
  IconRefresh,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons';
import startCase from 'lodash/startCase';
import { MasonryScroller, useContainerPosition, usePositioner, useResizeObserver } from 'masonic';
import { useRef } from 'react';

import { constants, ModelFileType } from '~/server/common/constants';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { ModelVersionById } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';
import { getFileExtension } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import {
  FileFromContextProps,
  FilesProvider,
  useFilesContext,
} from '~/components/Resource/FilesProvider';

type DropzoneOptions = {
  acceptedFileTypes: string[];
  acceptedModelFiles: ModelFileType[];
  maxFiles: number;
};

const dropzoneOptionsByModelType: Record<ModelType, DropzoneOptions> = {
  Checkpoint: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip', '.yaml', '.yml'],
    acceptedModelFiles: ['Model', 'Config', 'VAE', 'Training Data'],
    maxFiles: 11,
  },
  LORA: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Text Encoder', 'Training Data'],
    maxFiles: 3,
  },
  LoCon: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Text Encoder', 'Training Data'],
    maxFiles: 3,
  },
  TextualInversion: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Negative', 'Training Data'],
    maxFiles: 3,
  },
  Hypernetwork: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Training Data'],
    maxFiles: 2,
  },
  AestheticGradient: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Training Data'],
    maxFiles: 2,
  },
  Controlnet: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.bin'],
    acceptedModelFiles: ['Model'],
    maxFiles: 2,
  },
  Poses: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
  Wildcards: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
  Other: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
};

export function Files({ model, version }: Props) {
  return (
    <FilesProvider model={model} version={version}>
      <FilesComponent model={model} version={version} />
    </FilesProvider>
  );
}

function FilesComponent({ model }: Props) {
  const theme = useMantineTheme();

  const { files, onDrop, startUpload, hasPending } = useFilesContext();

  const masonryRef = useRef(null);
  const { width, height } = useViewportSize();
  const { offset, width: containerWidth } = useContainerPosition(masonryRef, [width, height]);
  const positioner = usePositioner(
    {
      width: containerWidth,
      maxColumnCount: 2,
      columnGutter: theme.spacing.md,
    },
    [files.length]
  );
  const resizeObserver = useResizeObserver(positioner);

  const { acceptedModelFiles, acceptedFileTypes, maxFiles } =
    dropzoneOptionsByModelType[model?.type ?? 'Checkpoint'];

  return (
    <Stack>
      <Dropzone
        accept={{ 'application/octet-stream': acceptedFileTypes }}
        onDrop={onDrop}
        maxFiles={maxFiles}
      >
        <Group position="center" spacing="xl" style={{ minHeight: 120, pointerEvents: 'none' }}>
          <Dropzone.Accept>
            <IconUpload
              size={50}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][theme.colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={50}
              stroke={1.5}
              color={theme.colors.red[theme.colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconFileUpload size={50} stroke={1.5} />
          </Dropzone.Idle>

          <Stack spacing={8}>
            <Text size="xl" inline>
              Drop your files here or click to select
            </Text>
            <Text size="sm" color="dimmed" inline>
              {`Attach up to ${maxFiles} files. Accepted file types: ${acceptedFileTypes.join(
                ', '
              )}`}
            </Text>
          </Stack>
        </Group>
      </Dropzone>
      {files.length > 0 ? (
        <Button onClick={startUpload} size="lg" disabled={!hasPending} fullWidth>
          Start Upload
        </Button>
      ) : null}
      <MasonryScroller
        containerRef={masonryRef}
        positioner={positioner}
        resizeObserver={resizeObserver}
        offset={offset}
        height={height}
        items={files}
        render={({ data, index }) => (
          <FileCard
            key={data.uuid}
            file={data}
            fileTypes={acceptedModelFiles}
            modelId={model?.id}
            index={index}
          />
        )}
      />
    </Stack>
  );
}

type Props = {
  model?: Partial<ModelUpsertInput>;
  version?: Partial<ModelVersionById>;
  onStartUploadClick?: VoidFunction;
};

function FileCard({ file: versionFile, fileTypes, modelId, index }: FileCardProps) {
  const { errors, updateFile, removeFile } = useFilesContext();
  const error = errors?.[index];
  const queryUtils = trpc.useContext();

  const { type, size, fp, versionId } = versionFile;
  const failedUpload = status === 'error' || status === 'aborted';

  const deleteFileMutation = trpc.modelFile.delete.useMutation({
    async onSuccess(response, request) {
      await queryUtils.modelVersion.getById.invalidate({ id: versionId });
      if (modelId) await queryUtils.model.getById.invalidate({ id: modelId });
      removeFile(versionFile.uuid);
    },
    onError() {
      showErrorNotification({
        error: new Error('Could not delete file, please try again'),
      });
    },
  });
  const handleRemoveFile = async () => {
    if (versionFile.id) await deleteFileMutation.mutateAsync({ id: versionFile.id });
  };

  const filterByFileExtension = (value: ModelFileType) => {
    const file = versionFile.file;
    if (!file) return false;
    const extension = getFileExtension(file.name);

    switch (extension) {
      case 'ckpt':
      case 'safetensors':
        return ['Model', 'VAE'].includes(value);
      case 'pt':
        return ['Model', 'Negative', 'Text Encoder', 'VAE'].includes(value);
      case 'zip':
        return ['Training Data', 'Archive'].includes(value);
      case 'yml':
      case 'yaml':
        return ['Config'].includes(value);
      case 'bin':
        return ['Model', 'Negative'].includes(value);
      default:
        return true;
    }
  };

  return (
    <Card sx={{ opacity: deleteFileMutation.isLoading ? 0.2 : undefined }} withBorder>
      <Stack spacing={4} pb="xs">
        <Group position="apart" spacing={4} noWrap>
          <Text
            lineClamp={1}
            color={failedUpload ? 'red' : undefined}
            sx={{ display: 'inline-block' }}
          >
            {versionFile.name}
          </Text>
          {!!versionFile.id && (
            <Tooltip label="Remove file" position="left">
              <ActionIcon
                color="red"
                onClick={handleRemoveFile}
                loading={deleteFileMutation.isLoading}
              >
                <IconTrash />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        {!!versionFile.id ? (
          <>
            <Stack spacing={0}>
              <Text size="sm" weight="bold">
                File Type
              </Text>
              <Text size="sm" color="dimmed">
                {versionFile.type ?? 'undefined'}
              </Text>
            </Stack>
            {versionFile.type === 'Model' ? (
              <>
                <Stack spacing={0}>
                  <Text size="sm" weight="bold">
                    Model size
                  </Text>
                  <Text size="sm" color="dimmed">
                    {size ?? 'undefined'}
                  </Text>
                </Stack>
                <Stack spacing={0}>
                  <Text size="sm" weight="bold">
                    Floating point
                  </Text>
                  <Text size="sm" color="dimmed">
                    {fp ?? 'undefined'}
                  </Text>
                </Stack>
              </>
            ) : null}
          </>
        ) : (
          <>
            <Select
              label="File Type"
              placeholder="Select a type"
              error={error?.type?._errors[0]}
              data={fileTypes.filter(filterByFileExtension)}
              value={versionFile.type ?? null}
              onChange={(value: ModelFileType | null) =>
                updateFile(versionFile.uuid, { type: value, size: null, fp: null })
              }
              withAsterisk
              withinPortal
            />
            {type === 'Model' && (
              <>
                <Select
                  label="Model Size"
                  placeholder="Pruned or Full"
                  data={constants.modelFileSizes.map((size) => ({
                    label: startCase(size),
                    value: size,
                  }))}
                  error={error?.size?._errors[0]}
                  value={versionFile.size ?? null}
                  onChange={(value: 'Full' | 'Pruned' | null) => {
                    updateFile(versionFile.uuid, { size: value });
                  }}
                  withAsterisk
                  withinPortal
                />

                <Select
                  label="Floating Point"
                  placeholder="fp16 or fp32"
                  data={constants.modelFileFp}
                  error={error?.fp?._errors[0]}
                  value={versionFile.fp ?? null}
                  onChange={(value: 'fp16' | 'fp32' | null) => {
                    updateFile(versionFile.uuid, { fp: value });
                  }}
                  withAsterisk
                  withinPortal
                />
              </>
            )}
          </>
        )}
      </Stack>
      <Card.Section>
        <TrackedFile uuid={versionFile.uuid} />
      </Card.Section>
    </Card>
  );
}

type FileCardProps = {
  file: FileFromContextProps;
  fileTypes: ModelFileType[];
  modelId?: number;
  index: number;
};

function TrackedFile({ uuid: versionFileUuid }: { uuid: string }) {
  const items = useS3UploadStore((state) => state.items);
  const trackedFile = items.find((x) => x.meta?.uuid === versionFileUuid);

  if (!trackedFile) return null;

  return (
    <>
      <Divider />
      <Group spacing="xs" py="md" px="sm" sx={{ width: '100%' }}>
        <TrackedFileStatus trackedFile={trackedFile} versionFileUuid={versionFileUuid} />
      </Group>
    </>
  );
}

function TrackedFileStatus({
  trackedFile,
  versionFileUuid,
}: {
  trackedFile: TrackedFile;
  versionFileUuid: string;
}) {
  const theme = useMantineTheme();
  const clear = useS3UploadStore((state) => state.clear);
  const abort = useS3UploadStore((state) => state.abort);
  const { retry, removeFile } = useFilesContext();

  const { uuid, status, progress, timeRemaining, speed } = trackedFile;

  const handleRemoveFile = () => {
    clear((x) => x.uuid === trackedFile.uuid);
    removeFile(versionFileUuid);
  };

  switch (status) {
    case 'uploading':
      return (
        <Group position="apart" noWrap spacing="xs" sx={{ width: '100%' }}>
          <IconCloudUpload color={theme.colors.blue[theme.fn.primaryShade()]} />
          <Stack spacing={4} sx={{ flex: '1 !important' }}>
            <Group spacing={4}>
              <Progress
                size="xl"
                radius="xs"
                value={progress}
                label={`${Math.floor(progress)}%`}
                color={progress < 100 ? 'blue' : 'green'}
                striped
                animate
                sx={{ flex: 1 }}
              />
              <Tooltip label="Cancel upload" position="left">
                <ActionIcon color="red" onClick={() => abort(uuid)}>
                  <IconX />
                </ActionIcon>
              </Tooltip>
            </Group>
            <Group position="apart" noWrap>
              <Text color="dimmed" size="xs">{`${formatBytes(speed)}/s`}</Text>
              <Text color="dimmed" size="xs">{`${formatSeconds(timeRemaining)} remaining`}</Text>
            </Group>
          </Stack>
        </Group>
      );
    case 'aborted':
      return (
        <Group position="apart" noWrap spacing="xs" sx={{ width: '100%' }}>
          <Group spacing="xs">
            <IconBan color="red" />
            <Text size="sm">Aborted upload</Text>
          </Group>
          <Tooltip label="Remove file" position="left">
            <ActionIcon color="red" onClick={handleRemoveFile}>
              <IconTrash />
            </ActionIcon>
          </Tooltip>
        </Group>
      );
    case 'error':
      return (
        <Group position="apart" noWrap spacing="xs" sx={{ width: '100%' }}>
          <Group spacing="xs">
            <IconBan color="red" />
            <Text size="sm">Failed to upload</Text>
          </Group>
          <Tooltip label="Retry upload" position="left">
            <ActionIcon color="blue" onClick={() => retry(versionFileUuid)}>
              <IconRefresh />
            </ActionIcon>
          </Tooltip>
        </Group>
      );
    case 'success':
      return (
        <>
          <IconCircleCheck color="green" />
          <Text size="sm">Upload completed</Text>
        </>
      );
    case 'pending':
      return (
        <Group position="apart" noWrap spacing="xs" sx={{ width: '100%' }}>
          <Group spacing="xs">
            <IconCloudUpload />
            <Text size="sm">Pending upload</Text>
          </Group>
          <Tooltip label="Remove file" position="left">
            <ActionIcon color="red" onClick={handleRemoveFile}>
              <IconTrash />
            </ActionIcon>
          </Tooltip>
        </Group>
      );
    default:
      return null;
  }
}
