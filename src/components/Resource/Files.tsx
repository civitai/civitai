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
import { isEqual, startCase } from 'lodash-es';
import { MasonryScroller, useContainerPosition, usePositioner, useResizeObserver } from 'masonic';
import { useRef, useState, useEffect } from 'react';

import { constants, ModelFileType } from '~/server/common/constants';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { ModelVersionById } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';
import { getDisplayName, getFileExtension } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import {
  FileFromContextProps,
  FilesProvider,
  useFilesContext,
} from '~/components/Resource/FilesProvider';

export function Files({ model, version }: Props) {
  return (
    <FilesProvider model={model} version={version}>
      <FilesComponent model={model} version={version} />
    </FilesProvider>
  );
}

function FilesComponent({ model }: Props) {
  const theme = useMantineTheme();

  const { files, onDrop, startUpload, hasPending, fileExtensions, maxFiles } = useFilesContext();

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

  return (
    <Stack>
      <Dropzone accept={{ 'mime/type': fileExtensions }} onDrop={onDrop} maxFiles={maxFiles}>
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
              {`Attach up to ${maxFiles} files. Accepted file types: ${fileExtensions.join(', ')}`}
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
        render={FileCard}
      />
    </Stack>
  );
}

type Props = {
  model?: Partial<ModelUpsertInput>;
  version?: Partial<ModelVersionById>;
  onStartUploadClick?: VoidFunction;
};

function FileCard({ data: versionFile, index }: { data: FileFromContextProps; index: number }) {
  const { removeFile, fileTypes, modelId } = useFilesContext();
  const queryUtils = trpc.useContext();

  const failedUpload = status === 'error' || status === 'aborted';

  const deleteFileMutation = trpc.modelFile.delete.useMutation({
    async onSuccess(response, request) {
      await queryUtils.modelVersion.getById.invalidate({ id: versionFile.versionId });
      if (modelId) await queryUtils.model.getById.invalidate({ id: modelId });
      removeFile(versionFile.uuid);
    },
    onError() {
      showErrorNotification({
        error: new Error('Could not delete file, please try again'),
      });
    },
  });
  const handleRemoveFile = async (uuid?: string) => {
    if (versionFile.id) await deleteFileMutation.mutateAsync({ id: versionFile.id });
    else if (uuid) removeFile(uuid);
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
          {!versionFile.isUploading && (
            <Tooltip label="Remove file" position="left">
              <ActionIcon
                color="red"
                onClick={() => handleRemoveFile(versionFile.uuid)}
                loading={deleteFileMutation.isLoading}
              >
                <IconTrash />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        {versionFile.isUploading ? (
          <>
            <Stack spacing={0}>
              <Text size="sm" weight="bold">
                File Type
              </Text>
              <Text size="sm" color="dimmed">
                {getDisplayName(
                  versionFile.type === 'Model'
                    ? versionFile.modelType ?? versionFile.type ?? 'undefined'
                    : versionFile.type ?? 'undefined'
                )}
              </Text>
            </Stack>
            {versionFile.type === 'Model' && versionFile.modelType === 'Checkpoint' ? (
              <>
                <Stack spacing={0}>
                  <Text size="sm" weight="bold">
                    Model size
                  </Text>
                  <Text size="sm" color="dimmed">
                    {versionFile.size ?? 'undefined'}
                  </Text>
                </Stack>
                <Stack spacing={0}>
                  <Text size="sm" weight="bold">
                    Floating point
                  </Text>
                  <Text size="sm" color="dimmed">
                    {versionFile.fp ?? 'undefined'}
                  </Text>
                </Stack>
              </>
            ) : null}
          </>
        ) : (
          <FileEditForm file={versionFile} fileTypes={fileTypes} index={index} />
        )}
      </Stack>
      <Card.Section>
        <TrackedFile uuid={versionFile.uuid} />
      </Card.Section>
    </Card>
  );
}

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

function FileEditForm({
  file: versionFile,
  index,
  fileTypes,
}: {
  file: FileFromContextProps;
  index: number;
  fileTypes: ModelFileType[];
}) {
  const [initialFile, setInitialFile] = useState({ ...versionFile });
  const { errors, updateFile, validationCheck } = useFilesContext();
  const error = errors?.[index];

  const { mutate, isLoading } = trpc.modelFile.update.useMutation({
    onSuccess: () => {
      setInitialFile(versionFile);
    },
  });

  const handleSave = () => {
    const valid = validationCheck();
    if (valid) {
      mutate({
        id: versionFile.id,
        type: versionFile.type ?? undefined,
        metadata: {
          fp: versionFile.fp ?? undefined,
          size: versionFile.size ?? undefined,
        },
      });
    }
  };

  const filterByFileExtension = (value: ModelFileType) => {
    // const file = versionFile.file;
    // if (!file) return false;
    const extension = getFileExtension(versionFile.name);

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

  const handleReset = () => {
    updateFile(versionFile.uuid, {
      type: initialFile.type,
      size: initialFile.size,
      fp: initialFile.fp,
    });
  };

  const canManualSave = !!versionFile.id && !isEqual(versionFile, initialFile);

  return (
    <Stack>
      <Select
        label="File Type"
        placeholder="Select a type"
        error={error?.type?._errors[0]}
        data={fileTypes.filter(filterByFileExtension).map((x) => ({
          label: getDisplayName(x === 'Model' ? versionFile.modelType ?? x : x),
          value: x,
        }))}
        value={versionFile.type ?? null}
        onChange={(value: ModelFileType | null) =>
          updateFile(versionFile.uuid, { type: value, size: null, fp: null })
        }
        withAsterisk
        withinPortal
      />
      {versionFile.type === 'Model' && versionFile.modelType === 'Checkpoint' && (
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
            onChange={(value: 'full' | 'pruned' | null) => {
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
      {canManualSave && (
        <Group grow>
          <Button onClick={handleReset} variant="default" disabled={isLoading}>
            Reset
          </Button>
          <Button loading={isLoading} variant="filled" onClick={handleSave}>
            Save
          </Button>
        </Group>
      )}
    </Stack>
  );
}
