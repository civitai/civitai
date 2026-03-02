import {
  Button,
  Card,
  Divider,
  getPrimaryShade,
  Group,
  Progress,
  Select,
  Stack,
  Text,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
  Badge,
  Title,
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
  IconLink,
  IconRefresh,
  IconTrash,
  IconX,
  IconFile3d,
  IconPuzzle,
  IconFileSettings,
} from '@tabler/icons-react';
import { isEqual, startCase } from 'lodash-es';
import { useContainerPosition, usePositioner } from 'masonic';
import { useRef, useState } from 'react';

import { UploadNotice } from '~/components/UploadNotice/UploadNotice';
import type { FileFromContextProps } from '~/components/Resource/FilesProvider';
import { useFilesContext } from '~/components/Resource/FilesProvider';
import type { ModelFileType, ZipModelFileType } from '~/server/common/constants';
import { constants, zipModelFileTypes } from '~/server/common/constants';
// import { ModelUpsertInput } from '~/server/schema/model.schema';
import { useS3UploadStore } from '~/store/s3-upload.store';
// import { ModelVersionById } from '~/types/router';
import { removeDuplicates } from '~/utils/array-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';
import { getDisplayName, getFileExtension } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import classes from './Files.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { isAndroidDevice } from '~/utils/device-helpers';
import type { LinkedComponent } from '~/components/Resource/LinkComponentModal';
import { openLinkComponentModal } from '~/components/Resource/LinkComponentModal';

// TODO.Briant - compare file extension when checking for duplicate files
export function Files() {
  const {
    files,
    linkedComponents,
    onDrop,
    startUpload,
    hasPending,
    fileExtensions,
    maxFiles,
    addLinkedComponent,
    removeLinkedComponent,
  } = useFilesContext();

  const masonryRef = useRef(null);
  const { width, height } = useViewportSize();
  const { width: containerWidth } = useContainerPosition(masonryRef, [width, height]);
  usePositioner(
    {
      width: containerWidth,
      maxColumnCount: 2,
      columnGutter: 16,
    },
    [files.length]
  );

  // Get existing component types to avoid duplicates
  const existingComponentTypes = linkedComponents.map((c) => c.componentType);

  // Categorize files by type
  const modelFiles = files.filter((f) => ['Model', 'Pruned Model'].includes(f.type ?? ''));
  const requiredComponents = files.filter((f) => ['VAE', 'Text Encoder'].includes(f.type ?? ''));
  const optionalFiles = files.filter(
    (f) => !['Model', 'Pruned Model', 'VAE', 'Text Encoder'].includes(f.type ?? '')
  );

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
        className={classes.dropzoneReject}
        useFsAccessApi={!isAndroidDevice()}
      >
        <Group justify="center" gap="xl" style={{ minHeight: 120, pointerEvents: 'none' }}>
          {/* <Dropzone.Accept>
            <IconUpload
              size={50}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={50}
              stroke={1.5}
              color={theme.colors.red[colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconFileUpload size={50} stroke={1.5} />
          </Dropzone.Idle> */}

          <IconFileUpload size={50} stroke={1.5} />
          <Stack gap={8} align="center" justify="center">
            <Text size="xl" inline>
              Drop your files here or click to select
            </Text>
            <Text size="sm" c="dimmed" inline>
              {`Attach up to ${maxFiles} files. Accepted file types: ${fileExtensions.join(', ')}`}
            </Text>
          </Stack>
        </Group>
      </Dropzone>
      <UploadNotice className="-mt-2" />
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

      {/* Model Files Section */}
      {modelFiles.length > 0 && (
        <Stack gap="md">
          <Group gap="xs">
            <IconFile3d size={20} style={{ color: 'var(--mantine-color-blue-4)' }} />
            <Title order={4}>Model Files</Title>
          </Group>
          <Text size="sm" c="dimmed">
            The main model files users will download. We&apos;ll show the best match based on their
            preferences.
          </Text>
          <Stack gap="md">
            {modelFiles.map((file) => (
              <FileCard key={file.uuid} data={file} index={files.indexOf(file)} />
            ))}
          </Stack>
        </Stack>
      )}

      {/* Required Components Section */}
      {(requiredComponents.length > 0 || linkedComponents.length > 0) && (
        <Card
          withBorder
          style={{
            borderColor: 'var(--mantine-color-yellow-6)',
            backgroundColor: 'rgba(250, 176, 5, 0.03)',
          }}
        >
          <Stack gap="md">
            <Group gap="xs" justify="space-between" wrap="nowrap">
              <Group gap="xs">
                <IconPuzzle size={20} style={{ color: 'var(--mantine-color-yellow-6)' }} />
                <Title order={4}>Required Components</Title>
                <Badge color="yellow" variant="light">
                  Users must download
                </Badge>
              </Group>
              <Button
                variant="light"
                size="xs"
                leftSection={<IconLink size={14} />}
                onClick={() =>
                  openLinkComponentModal({
                    onSave: addLinkedComponent,
                    existingComponentTypes,
                  })
                }
              >
                Link Existing
              </Button>
            </Group>
            <Text size="sm" c="dimmed">
              Additional files users need to run this model. Upload files or link to existing models
              on Civitai.
            </Text>
            <Stack gap="md">
              {requiredComponents.map((file) => (
                <FileCard key={file.uuid} data={file} index={files.indexOf(file)} />
              ))}
              {linkedComponents.map((component) => (
                <LinkedComponentCard
                  key={component.componentType}
                  component={component}
                  onRemove={removeLinkedComponent}
                />
              ))}
            </Stack>
          </Stack>
        </Card>
      )}

      {/* Link Component Button - shown when no required components yet */}
      {requiredComponents.length === 0 && linkedComponents.length === 0 && (
        <Button
          variant="light"
          color="yellow"
          leftSection={<IconLink size={16} />}
          onClick={() =>
            openLinkComponentModal({
              onSave: addLinkedComponent,
              existingComponentTypes,
            })
          }
        >
          Link Required Component from Civitai
        </Button>
      )}

      {/* Optional Files Section */}
      {optionalFiles.length > 0 && (
        <Stack gap="md">
          <Group gap="xs">
            <IconFileSettings size={20} style={{ color: 'var(--mantine-color-dimmed)' }} />
            <Title order={4}>Optional Files</Title>
          </Group>
          <Text size="sm" c="dimmed">
            Workflows, configs, and other helpful files. Not required to use the model.
          </Text>
          <Stack gap="md">
            {optionalFiles.map((file) => (
              <FileCard key={file.uuid} data={file} index={files.indexOf(file)} />
            ))}
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}

// type Props = {
//   model?: Partial<ModelUpsertInput>;
//   version?: Partial<ModelVersionById>;
//   onStartUploadClick?: VoidFunction;
// };

// Card for displaying a linked component from another Civitai model
function LinkedComponentCard({
  component,
  onRemove,
}: {
  component: LinkedComponent;
  onRemove: (componentType: ModelFileComponentType) => void;
}) {
  return (
    <Card withBorder style={{ borderColor: 'var(--mantine-color-blue-4)' }}>
      <Stack gap={4} pb="xs">
        <Group justify="space-between" gap={4} wrap="nowrap">
          <Group gap="xs">
            <IconLink size={16} style={{ color: 'var(--mantine-color-blue-4)' }} />
            <Text lineClamp={1} style={{ display: 'inline-block' }}>
              {component.modelName}
            </Text>
            <Badge size="xs" color="blue" variant="light">
              Linked
            </Badge>
          </Group>
          <Tooltip label="Remove linked component" position="left">
            <LegacyActionIcon color="red" onClick={() => onRemove(component.componentType)}>
              <IconTrash />
            </LegacyActionIcon>
          </Tooltip>
        </Group>
        <Stack gap={0}>
          <Text size="sm" fw="bold">
            Component Type
          </Text>
          <Text size="sm" c="dimmed">
            {component.componentType}
          </Text>
        </Stack>
        <Stack gap={0}>
          <Text size="sm" fw="bold">
            Version
          </Text>
          <Text size="sm" c="dimmed">
            {component.versionName}
          </Text>
        </Stack>
        <Stack gap={0}>
          <Text size="sm" fw="bold">
            File
          </Text>
          <Text size="sm" c="dimmed">
            {component.fileName}
          </Text>
        </Stack>
      </Stack>
    </Card>
  );
}

function FileCard({ data: versionFile, index }: { data: FileFromContextProps; index: number }) {
  const { removeFile, fileTypes, modelId } = useFilesContext();
  const queryUtils = trpc.useUtils();
  const failedUpload = versionFile.status === 'error' || versionFile.status === 'aborted';

  // File card benefits from knowing if a tracked file exist.
  const trackedFiles = useS3UploadStore((state) => state.items);
  const trackedFile = trackedFiles.find((x) => x.meta?.uuid === versionFile.uuid);

  const deleteFileMutation = trpc.modelFile.delete.useMutation({
    async onSuccess() {
      await queryUtils.modelVersion.getById.invalidate({
        id: versionFile.versionId,
        withFiles: true,
      });
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
    <Card style={{ opacity: deleteFileMutation.isLoading ? 0.2 : undefined }} withBorder>
      <Stack gap={4} pb="xs">
        <Group justify="space-between" gap={4} wrap="nowrap">
          <Text
            lineClamp={1}
            color={failedUpload ? 'red' : undefined}
            style={{ display: 'inline-block' }}
          >
            {versionFile.name}
          </Text>
          {/* Checking for tracked files here is a safeguard for failed uploads that ended up in the air.*/}
          {(!versionFile.isUploading || !trackedFile) && (
            <Tooltip label="Remove file" position="left">
              <LegacyActionIcon
                color="red"
                onClick={() => handleRemoveFile(versionFile.uuid)}
                loading={deleteFileMutation.isLoading}
              >
                <IconTrash />
              </LegacyActionIcon>
            </Tooltip>
          )}
        </Group>
        {versionFile.isUploading ? (
          <>
            <Stack gap={0}>
              <Text size="sm" fw="bold">
                File Type
              </Text>
              <Text size="sm" c="dimmed">
                {getDisplayName(
                  versionFile.type === 'Model'
                    ? versionFile.modelType ?? versionFile.type ?? 'undefined'
                    : versionFile.type ?? 'undefined'
                )}
              </Text>
            </Stack>
            {versionFile.type === 'Model' && versionFile.modelType === 'Checkpoint' ? (
              <>
                <Stack gap={0}>
                  <Text size="sm" fw="bold">
                    Model size
                  </Text>
                  <Text size="sm" c="dimmed">
                    {versionFile.size ?? 'undefined'}
                  </Text>
                </Stack>
                <Stack gap={0}>
                  <Text size="sm" fw="bold">
                    Floating point
                  </Text>
                  <Text size="sm" c="dimmed">
                    {versionFile.fp ?? 'undefined'}
                  </Text>
                </Stack>
                {versionFile.name.endsWith('.zip') && (
                  <Stack gap={0}>
                    <Text size="sm" fw="bold">
                      Format
                    </Text>
                    <Text size="sm" c="dimmed">
                      {versionFile.format ?? 'undefined'}
                    </Text>
                  </Stack>
                )}
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
      <Group gap="xs" py="md" px="sm" style={{ width: '100%' }}>
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
  const colorScheme = useComputedColorScheme('dark');
  const clear = useS3UploadStore((state) => state.clear);
  const abort = useS3UploadStore((state) => state.abort);
  const { retry, removeFile, updateFile } = useFilesContext();

  const { uuid, status, progress, timeRemaining, speed } = trackedFile;

  const handleRemoveFile = async () => {
    try {
      await clear((x) => x.uuid === trackedFile.uuid);
      removeFile(versionFileUuid);
    } catch (e) {
      showErrorNotification({
        title: 'There was an error while removing the file',
        error: e as Error,
      });
    }
  };

  switch (status) {
    case 'uploading':
      return (
        <Group justify="space-between" wrap="nowrap" gap="xs" style={{ width: '100%' }}>
          <IconCloudUpload color={theme.colors.blue[getPrimaryShade(theme, colorScheme)]} />
          <Stack gap={4} w="100%" style={{ flex: '1 !important' }}>
            <Group gap={4}>
              <Progress.Root size="xl" radius="xs" style={{ flex: 1 }}>
                <Progress.Section
                  value={progress}
                  color={progress < 100 ? 'blue' : 'green'}
                  striped
                  animated
                  style={{
                    backgroundColor: theme.colors.blue[colorScheme === 'dark' ? 4 : 6],
                  }}
                >
                  <Progress.Label>{`${Math.floor(progress)}%`}</Progress.Label>
                </Progress.Section>
              </Progress.Root>
              <Tooltip label="Cancel upload" position="left">
                <LegacyActionIcon
                  color="red"
                  onClick={() => {
                    abort(uuid);
                    updateFile(versionFileUuid, { status: 'aborted' });
                  }}
                >
                  <IconX />
                </LegacyActionIcon>
              </Tooltip>
            </Group>
            <Group justify="space-between" wrap="nowrap">
              <Text c="dimmed" size="xs">{`${formatBytes(speed)}/s`}</Text>
              <Text c="dimmed" size="xs">{`${formatSeconds(timeRemaining)} remaining`}</Text>
            </Group>
          </Stack>
        </Group>
      );
    case 'aborted':
      return (
        <Group justify="space-between" wrap="nowrap" gap="xs" style={{ width: '100%' }}>
          <Group gap="xs">
            <IconBan color="red" />
            <Text size="sm">Aborted upload</Text>
          </Group>
          <Tooltip label="Remove file" position="left">
            <LegacyActionIcon color="red" onClick={handleRemoveFile}>
              <IconTrash />
            </LegacyActionIcon>
          </Tooltip>
        </Group>
      );
    case 'error':
      return (
        <Group justify="space-between" wrap="nowrap" gap="xs" style={{ width: '100%' }}>
          <Group gap="xs">
            <IconBan color="red" />
            <Text size="sm">Failed to upload</Text>
          </Group>
          <Tooltip label="Retry upload" position="left">
            <LegacyActionIcon color="blue" onClick={() => retry(versionFileUuid)}>
              <IconRefresh />
            </LegacyActionIcon>
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
        <Group justify="space-between" wrap="nowrap" gap="xs" style={{ width: '100%' }}>
          <Group gap="xs">
            <IconCloudUpload />
            <Text size="sm">Pending upload</Text>
          </Group>
          <Tooltip label="Remove file" position="left">
            <LegacyActionIcon color="red" onClick={handleRemoveFile}>
              <IconTrash />
            </LegacyActionIcon>
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
    if (valid && versionFile.id) {
      mutate({
        id: versionFile.id,
        type: versionFile.type ?? undefined,
        metadata: {
          fp: versionFile.fp ?? undefined,
          size: versionFile.size ?? undefined,
          format: versionFile.format ?? undefined,
          quantType: versionFile.quantType ?? undefined,
          componentType: versionFile.componentType ?? undefined,
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
        return ['Model', 'Negative', 'VAE'].includes(value);
      case 'pt':
        return ['Model', 'Negative', 'VAE'].includes(value);
      case 'zip':
        return ['Training Data', 'Archive', 'Model'].includes(value);
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
      quantType: initialFile.quantType,
      componentType: initialFile.componentType,
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
        onChange={(value) => {
          const newType = value as ModelFileType | null;
          // Auto-suggest componentType based on file type
          let suggestedComponentType: ModelFileComponentType | null = null;
          if (newType === 'VAE') suggestedComponentType = 'VAE';
          else if (newType === 'Text Encoder') suggestedComponentType = 'TextEncoder';
          else if (newType === 'Config') suggestedComponentType = 'Config';

          updateFile(versionFile.uuid, {
            type: newType,
            size: null,
            fp: null,
            componentType: suggestedComponentType,
          });
        }}
        withAsterisk
      />

      {versionFile.type && !['Model', 'Pruned Model'].includes(versionFile.type) && (
        <Tooltip
          label="Specify what type of component this file is for users who need to download it separately."
          multiline
          w={300}
        >
          <Select
            label="Component Type"
            placeholder="VAE, Text Encoder, UNet..."
            data={constants.modelFileComponentTypes}
            error={error?.componentType?._errors[0]}
            value={versionFile.componentType ?? null}
            onChange={(value) => {
              updateFile(versionFile.uuid, {
                componentType: value as ModelFileComponentType | null,
              });
            }}
          />
        </Tooltip>
      )}

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
            onChange={(value) => {
              updateFile(versionFile.uuid, { size: value as 'full' | 'pruned' | null });
            }}
            withAsterisk
          />

          <Select
            label="Precision"
            placeholder="fp16, fp32, bf16, fp8, nf4"
            data={constants.modelFileFp}
            error={error?.fp?._errors[0]}
            value={versionFile.fp ?? null}
            onChange={(value) => {
              updateFile(versionFile.uuid, { fp: value as ModelFileFp | null });
            }}
            withAsterisk
          />

          {versionFile.name.endsWith('.gguf') && (
            <Tooltip
              label="Quantization level - Q8 offers best quality, Q4/Q2 are smaller. Users with GGUF preference will auto-select their preferred quant."
              multiline
              w={300}
            >
              <Select
                label="Quant Type"
                placeholder="Q8_0, Q6_K, Q4_K_M..."
                data={constants.modelFileQuantTypes}
                error={error?.quantType?._errors[0]}
                value={versionFile.quantType ?? null}
                onChange={(value) => {
                  updateFile(versionFile.uuid, { quantType: value as ModelFileQuantType | null });
                }}
                withAsterisk
              />
            </Tooltip>
          )}

          {versionFile.name.endsWith('.zip') && (
            <Select
              label="Format"
              placeholder="Diffusers, Core ML, ONNX"
              data={zipModelFileTypes.map((x) => ({ label: x, value: x }))}
              error={error?.format?._errors[0]}
              value={versionFile.format ?? null}
              onChange={(value) => {
                updateFile(versionFile.uuid, { format: value as ZipModelFileType | null });
              }}
              withAsterisk
            />
          )}
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
    <Group mt="xl" justify="flex-end">
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
                <Group gap="xs">
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
