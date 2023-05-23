import {
  ActionIcon,
  Button,
  Card,
  Divider,
  Group,
  Progress,
  Select,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { useViewportSize } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAlertTriangle,
  IconBan,
  IconCircleCheck,
  IconCloudUpload,
  IconFileUpload,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons';
import { isEqual, startCase } from 'lodash-es';
import { MasonryScroller, useContainerPosition, usePositioner, useResizeObserver } from 'masonic';
import { useRef, useState } from 'react';

import { FileFromContextProps, useFilesContext } from '~/components/Resource/FilesProvider';
import { constants, ModelFileType } from '~/server/common/constants';
// import { ModelUpsertInput } from '~/server/schema/model.schema';
import { useS3UploadStore } from '~/store/s3-upload.store';
// import { ModelVersionById } from '~/types/router';
import { removeDuplicates } from '~/utils/array-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';
import { getDisplayName, getFileExtension } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

// TODO.Briant - compare file extension when checking for duplicate files
export function Files() {
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
      <Dropzone
        accept={{ 'mime/type': fileExtensions }}
        onDrop={(droppedFiles) => {
          if (files.length + droppedFiles.length > maxFiles) return;

          onDrop(droppedFiles);
        }}
        maxFiles={maxFiles}
        onReject={(files) => {
          const errors = removeDuplicates(
            files.flatMap((file) => file.errors),
            'code'
          )
            .map((error) => error.message)
            .join('\n');

          showErrorNotification({ error: new Error(errors) });
        }}
        sx={(theme) => ({
          '&[data-reject]': { background: theme.colors.dark[5], borderColor: theme.colors.dark[4] },
        })}
      >
        <Group position="center" spacing="xl" style={{ minHeight: 120, pointerEvents: 'none' }}>
          {/* <Dropzone.Accept>
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
          </Dropzone.Idle> */}

          <IconFileUpload size={50} stroke={1.5} />
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
        <Button
          onClick={async () => {
            // Do nothing on thrown error
            await startUpload().catch(() => ({}));
          }}
          size="lg"
          disabled={!hasPending}
          fullWidth
        >
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

// type Props = {
//   model?: Partial<ModelUpsertInput>;
//   version?: Partial<ModelVersionById>;
//   onStartUploadClick?: VoidFunction;
// };

function FileCard({ data: versionFile, index }: { data: FileFromContextProps; index: number }) {
  const { removeFile, fileTypes, modelId } = useFilesContext();
  const queryUtils = trpc.useContext();

  const failedUpload = versionFile.status === 'error' || versionFile.status === 'aborted';

  const deleteFileMutation = trpc.modelFile.delete.useMutation({
    async onSuccess() {
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
  const { retry, removeFile, updateFile } = useFilesContext();

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
                <ActionIcon
                  color="red"
                  onClick={() => {
                    abort(uuid);
                    updateFile(versionFileUuid, { status: 'aborted' });
                  }}
                >
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
        return ['Model', 'Negative', 'VAE'].includes(value);
      case 'zip':
        return ['Training Data', 'Archive'].includes(value);
      case 'yml':
      case 'yaml':
        return ['Config', 'Text Encoder'].includes(value);
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

export function UploadStepActions({ onBackClick, onNextClick }: ActionProps) {
  const { startUpload, files, hasPending } = useFilesContext();

  return (
    <Group mt="xl" position="right">
      <Button variant="default" onClick={onBackClick}>
        Back
      </Button>
      <Button
        onClick={async () => {
          const allFailed = files.every(
            (file) => file.status === 'aborted' || file.status === 'error'
          );
          const showConfirmModal = !files.length || allFailed;

          if (showConfirmModal) {
            return openConfirmModal({
              title: (
                <Group spacing="xs">
                  <IconAlertTriangle color="gold" />
                  <Text size="lg">Missing files</Text>
                </Group>
              ),
              children:
                'You have not uploaded any files. You can continue without files, but you will not be able to publish your model. Are you sure you want to continue?',
              labels: { cancel: 'Cancel', confirm: 'Continue' },
              onConfirm: onNextClick,
            });
          }

          if (hasPending) {
            try {
              await startUpload();
            } catch (error) {
              // Avoid going to next step when thrown error
              return;
            }
          }
          return onNextClick();
        }}
      >
        Next
      </Button>
    </Group>
  );
}

type ActionProps = { onBackClick: () => void; onNextClick: () => void };
