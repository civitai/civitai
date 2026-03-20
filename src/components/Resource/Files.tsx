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
  ThemeIcon,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
  Badge,
  Switch,
} from '@mantine/core';
import { Dropzone, type FileRejection } from '@mantine/dropzone';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAlertTriangle,
  IconBan,
  IconBulb,
  IconCircleCheck,
  IconCloudUpload,
  IconLink,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
  IconFile3d,
  IconLayersLinked,
} from '@tabler/icons-react';
import { isEqual, startCase } from 'lodash-es';
import { useState } from 'react';

import { UploadNotice } from '~/components/UploadNotice/UploadNotice';
import type { FileFromContextProps } from '~/components/Resource/FilesProvider';
import { useFilesContext } from '~/components/Resource/FilesProvider';
import type { ModelFileType, ZipModelFileType } from '~/server/common/constants';
import { componentFileTypes, constants, zipModelFileTypes } from '~/server/common/constants';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { removeDuplicates } from '~/utils/array-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { formatBytes, formatKBytes, formatSeconds } from '~/utils/number-helpers';
import { getDisplayName, getFileExtension } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import classes from './Files.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { isAndroidDevice } from '~/utils/device-helpers';
import type { LinkedComponent } from '~/server/schema/model-file.schema';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import type { GenerationResource } from '~/shared/types/generation.types';
import { ModelType } from '~/shared/utils/prisma/enums';
import { getEcosystem, getCompatibleBaseModels } from '~/shared/constants/basemodel.constants';
import { componentTypeConfig, getFileIconConfig } from '~/utils/file-display-helpers';

// Small inline dropzone for adding files within a section
function InlineDropzone({
  label,
  description,
  onDrop,
  accept,
  maxFiles,
  onReject,
}: {
  label: string;
  description?: string;
  onDrop: (files: File[]) => void;
  accept?: Record<string, string[]>;
  maxFiles?: number;
  onReject?: (rejectedFiles: FileRejection[]) => void;
}) {
  return (
    <Dropzone
      onDrop={onDrop}
      accept={accept}
      maxFiles={maxFiles}
      onReject={onReject}
      styles={{
        root: {
          border: '2px dashed var(--mantine-color-dark-4)',
          borderRadius: 8,
          padding: 16,
          backgroundColor: 'transparent',
          cursor: 'pointer',
          '&:hover': {
            borderColor: 'var(--mantine-color-blue-5)',
            backgroundColor: 'rgba(34, 139, 230, 0.05)',
          },
        },
      }}
    >
      <Stack gap={4} align="center">
        <Group justify="center" gap="xs">
          <IconPlus size={14} style={{ color: 'var(--mantine-color-dimmed)' }} />
          <Text size="sm" c="dimmed">
            {label}
          </Text>
        </Group>
        {description && (
          <Text size="xs" c="dimmed">
            {description}
          </Text>
        )}
      </Stack>
    </Dropzone>
  );
}

function modelTypeToComponentType(modelType: ModelType): ModelFileComponentType {
  switch (modelType) {
    case ModelType.VAE:
      return 'VAE';
    case ModelType.Controlnet:
      return 'ControlNet';
    case ModelType.Other:
    default:
      return 'Other';
  }
}

// TODO.Briant - compare file extension when checking for duplicate files
export function Files() {
  const {
    files,
    linkedComponents,
    onDrop,
    dropzoneConfig,
    baseModel,
    addLinkedComponent,
    removeLinkedComponent,
  } = useFilesContext();

  const { primary, additional } = dropzoneConfig;
  const totalMaxFiles = primary.maxFiles + additional.maxFiles;
  const primaryTypes = primary.fileTypes;
  const additionalFileTypes = additional.fileTypes;

  const modelFiles = files.filter((f) => primaryTypes.includes(f.type as ModelFileType));
  const additionalFiles = files.filter((f) => !primaryTypes.includes(f.type as ModelFileType));

  const handleInlineDrop = (
    droppedFiles: File[],
    sectionFiles: FileFromContextProps[],
    sectionMaxFiles: number,
    defaultType?: ModelFileType
  ) => {
    if (sectionFiles.length + droppedFiles.length > sectionMaxFiles) return;
    if (files.length + droppedFiles.length > totalMaxFiles) return;
    onDrop(droppedFiles, defaultType);
  };

  const primaryAccept = { 'mime/type': primary.extensions };
  const additionalAccept = { 'mime/type': additional.extensions };
  const handleReject = (rejectedFiles: FileRejection[]) => {
    const errors = removeDuplicates(
      rejectedFiles.flatMap((file) => file.errors),
      'code'
    )
      .map((error) => error.message)
      .join('\n');
    showErrorNotification({ error: new Error(errors) });
  };

  const handleLinkResource = (resource: GenerationResource) => {
    const componentType = modelTypeToComponentType(resource.model.type);

    // Error notification is handled by the mutation's onError callback in FilesProvider
    addLinkedComponent({
      componentType,
      modelId: resource.model.id,
      modelName: resource.model.name,
      versionId: resource.id,
      versionName: resource.name,
      isRequired: true,
    }).catch(() => undefined);
  };

  const handleOpenResourceSelect = () => {
    // Compute compatible base models from the version's base model
    const ecosystem = baseModel ? getEcosystem(baseModel) : undefined;
    const resourceTypes = [
      ModelType.VAE,
      ModelType.Controlnet,
      ModelType.TextualInversion,
      ModelType.Hypernetwork,
    ] as const;

    const resources = resourceTypes.map((type) => {
      if (!ecosystem) return { type };
      const compat = getCompatibleBaseModels(ecosystem.id, type);
      const fullNames = compat.full.map((m) => m.name);
      const partialNames = compat.partial.map((m) => m.name);
      return {
        type,
        ...(fullNames.length > 0 && { baseModels: fullNames }),
        ...(partialNames.length > 0 && { partialSupport: partialNames }),
      };
    });

    openResourceSelectModal({
      title: 'Link Component',
      onSelect: handleLinkResource,
      options: {
        resources,
        excludeIds: linkedComponents.map((c) => c.versionId),
      },
      selectSource: 'modelVersion',
    });
  };

  const hasAdditionalContent = additionalFiles.length > 0 || linkedComponents.length > 0;

  return (
    <Stack>
      {/* Model Files Section - always visible */}
      <Card
        withBorder
        style={{
          borderColor: 'rgba(34, 139, 230, 0.2)',
          backgroundColor: 'rgba(34, 139, 230, 0.03)',
        }}
      >
        <Card.Section
          withBorder
          inheritPadding
          py="md"
          style={{ borderColor: 'rgba(34, 139, 230, 0.2)' }}
        >
          <Group gap="xs">
            <IconFile3d size={20} style={{ color: 'var(--mantine-color-blue-4)' }} />
            <Text fw={600} c="white">
              Model Files
            </Text>
          </Group>
          <Text size="sm" c="dimmed" mt={4}>
            The main model files users will download. We&apos;ll show the best match based on their
            preferences.
          </Text>
        </Card.Section>
        <Stack gap="sm" p="md">
          {modelFiles.length > 0 ? (
            <>
              {modelFiles.map((file) => (
                <FileCard
                  key={file.uuid}
                  data={file}
                  index={files.indexOf(file)}
                  fileTypes={primaryTypes}
                />
              ))}
              <InlineDropzone
                label="Add another model file variant"
                onDrop={(dropped) =>
                  handleInlineDrop(dropped, modelFiles, primary.maxFiles, primaryTypes[0])
                }
                accept={primaryAccept}
                maxFiles={primary.maxFiles}
                onReject={handleReject}
              />
            </>
          ) : (
            <Dropzone
              accept={primaryAccept}
              onDrop={(droppedFiles) => {
                if (modelFiles.length + droppedFiles.length > primary.maxFiles) return;
                if (files.length + droppedFiles.length > totalMaxFiles) return;
                onDrop(droppedFiles, primaryTypes[0]);
              }}
              maxFiles={primary.maxFiles}
              onReject={handleReject}
              className={classes.dropzoneReject}
              useFsAccessApi={!isAndroidDevice()}
              styles={{
                root: {
                  border: '2px dashed var(--mantine-color-dark-4)',
                  borderRadius: 'var(--mantine-radius-md)',
                  backgroundColor: 'transparent',
                  cursor: 'pointer',
                },
              }}
            >
              <Stack gap="xs" align="center" py="lg" style={{ pointerEvents: 'none' }}>
                <ThemeIcon size={48} radius="xl" variant="light" color="blue">
                  <IconCloudUpload size={22} />
                </ThemeIcon>
                <Text size="sm" fw={500}>
                  Drop model files here or click to browse
                </Text>
                <Text size="xs" c="dimmed">
                  {`Supports ${primary.extensions.join(', ')} files`}
                </Text>
              </Stack>
            </Dropzone>
          )}
        </Stack>
      </Card>

      {/* Additional Components Section - merged required + optional */}
      <Card withBorder>
        <Card.Section
          withBorder
          inheritPadding
          py="md"
          style={{ borderColor: 'var(--mantine-color-dark-4)' }}
        >
          <Group gap="xs">
            <IconLayersLinked size={20} style={{ color: 'var(--mantine-color-dimmed)' }} />
            <Text fw={600} c="white">
              Additional Components
            </Text>
          </Group>
          <Text size="sm" c="dimmed" mt={4}>
            Components and files that accompany this model. Mark each as required or optional.
          </Text>
        </Card.Section>
        <Stack gap="sm" p="md">
          {!hasAdditionalContent && (
            <Stack gap="xs" align="center" py="md">
              <IconLayersLinked
                size={32}
                style={{ color: 'var(--mantine-color-dimmed)', opacity: 0.25 }}
              />
              <Text size="sm" c="dimmed">
                No additional components yet
              </Text>
              <Text size="xs" c="dimmed" ta="center" maw={400}>
                Upload component files like VAE, Text Encoder, or UNet, or link to existing models
                on Civitai.
              </Text>
            </Stack>
          )}
          {additionalFiles.map((file) => (
            <FileCard
              key={file.uuid}
              data={file}
              index={files.indexOf(file)}
              showRequiredToggle
              fileTypes={additionalFileTypes}
            />
          ))}
          {linkedComponents.map((component) => (
            <LinkedComponentCard
              key={component.versionId}
              component={component}
              onRemove={() => removeLinkedComponent(component.versionId)}
              onToggleRequired={(isRequired) => {
                addLinkedComponent({ ...component, isRequired });
              }}
            />
          ))}
          <InlineDropzone
            label="Upload a component file"
            description={`Supports ${additional.extensions.join(', ')} files`}
            onDrop={(dropped) =>
              handleInlineDrop(
                dropped,
                additionalFiles,
                additional.maxFiles,
                additionalFileTypes[0]
              )
            }
            accept={additionalAccept}
            maxFiles={additional.maxFiles}
            onReject={handleReject}
          />
          <Text size="xs" c="dimmed" ta="center">
            or
          </Text>
          <Button
            variant="default"
            fullWidth
            leftSection={<IconLink size={16} />}
            onClick={handleOpenResourceSelect}
          >
            Link to Existing Model on Civitai
          </Button>
        </Stack>
      </Card>

      {/* Tips Card */}
      <Card
        withBorder
        style={{
          borderColor: 'rgba(144, 97, 249, 0.2)',
          backgroundColor: 'rgba(144, 97, 249, 0.03)',
        }}
      >
        <Group align="flex-start" gap="sm" wrap="nowrap">
          <IconBulb size={24} style={{ color: 'var(--mantine-color-violet-4)', flexShrink: 0 }} />
          <Stack gap={4}>
            <Text fw={500} c="white">
              Tips for better organization
            </Text>
            <Text size="sm" c="dimmed" component="div">
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                <li>
                  Add <strong>multiple precision variants</strong> (fp16, fp8) for both model files
                  and components
                </li>
                <li>Users&apos; preferences will auto-select the best match for their setup</li>
                <li>Link to existing models when the component already exists on Civitai</li>
                <li>
                  Only create a new <strong>version</strong> when you&apos;ve actually
                  trained/updated the model
                </li>
              </ul>
            </Text>
          </Stack>
        </Group>
      </Card>
      <UploadNotice />
    </Stack>
  );
}

// Compact horizontal card for linked components
function LinkedComponentCard({
  component,
  onRemove,
  onToggleRequired,
}: {
  component: LinkedComponent;
  onRemove: () => void;
  onToggleRequired: (isRequired: boolean) => void;
}) {
  const config = componentTypeConfig[component.componentType] ?? componentTypeConfig.Other;
  const Icon = config.icon;

  return (
    <Card
      withBorder
      p="sm"
      style={{
        borderColor: 'rgba(64, 192, 87, 0.2)',
        backgroundColor: 'rgba(64, 192, 87, 0.05)',
      }}
    >
      <Group gap="md" wrap="nowrap">
        <ThemeIcon size={40} radius="sm" color={config.color} variant="light">
          <Icon size={20} />
        </ThemeIcon>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={500} c="white" truncate>
            {component.modelName}
          </Text>
          <Group gap={4}>
            <IconLink size={12} style={{ color: 'var(--mantine-color-green-4)' }} />
            <Text size="xs" c="green.4" truncate>
              Linked: {component.versionName} &rarr; {component.fileName}
            </Text>
          </Group>
          <Switch
            size="xs"
            label="Required"
            checked={component.isRequired ?? true}
            onChange={(e) => onToggleRequired(e.currentTarget.checked)}
            mt={4}
          />
        </div>
        <Group gap="xs" wrap="nowrap">
          <div>
            <Text
              size="xs"
              fw={500}
              c="dimmed"
              tt="uppercase"
              style={{ letterSpacing: 0.5, fontSize: 11 }}
              mb={2}
            >
              Type
            </Text>
            <Select
              allowDeselect={false}
              size="xs"
              w={110}
              data={constants.modelFileComponentTypes.map((t) => ({
                label: componentTypeConfig[t]?.name ?? t,
                value: t,
              }))}
              value={component.componentType}
              disabled
            />
          </div>
          <LegacyActionIcon color="red" onClick={onRemove} style={{ marginTop: 18 }}>
            <IconTrash size={16} />
          </LegacyActionIcon>
        </Group>
      </Group>
    </Card>
  );
}

// Compact horizontal file card
function FileCard({
  data: versionFile,
  index,
  showRequiredToggle,
  fileTypes: fileTypesProp,
}: {
  data: FileFromContextProps;
  index: number;
  showRequiredToggle?: boolean;
  fileTypes?: ModelFileType[];
}) {
  const { removeFile, updateFile, dropzoneConfig, modelId } = useFilesContext();
  const allFileTypes = [
    ...dropzoneConfig.primary.fileTypes,
    ...dropzoneConfig.additional.fileTypes,
  ];
  const fileTypes = fileTypesProp ?? allFileTypes;
  const queryUtils = trpc.useUtils();
  const failedUpload = versionFile.status === 'error' || versionFile.status === 'aborted';

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

  const iconConfig = getFileIconConfig(versionFile.name, {
    format: versionFile.format,
  });
  const FileIcon = iconConfig.icon;
  const fileSizeStr = versionFile.sizeKB ? formatKBytes(versionFile.sizeKB) : undefined;
  const extension = getFileExtension(versionFile.name);
  const formatLabel = versionFile.format ?? (extension ? extension.toUpperCase() : undefined);

  return (
    <Card style={{ opacity: deleteFileMutation.isLoading ? 0.2 : undefined }} withBorder p="sm">
      <Group gap="md" wrap="nowrap">
        <ThemeIcon size={40} radius="sm" color={iconConfig.color} variant="light">
          <FileIcon size={20} />
        </ThemeIcon>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={500} c={failedUpload ? 'red' : 'white'} truncate>
              {versionFile.name}
            </Text>
            {!versionFile.type && !versionFile.isUploading && (
              <Badge color="yellow" variant="light" size="xs">
                Needs info
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {[fileSizeStr, formatLabel].filter(Boolean).join(' \u2022 ')}
          </Text>
          {showRequiredToggle && !versionFile.isUploading && (
            <Switch
              size="xs"
              label="Required"
              checked={versionFile.isRequired ?? false}
              onChange={(e) =>
                updateFile(versionFile.uuid, { isRequired: e.currentTarget.checked })
              }
              mt={4}
            />
          )}
        </div>
        {!versionFile.isUploading && (
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <FileEditForm file={versionFile} fileTypes={fileTypes} index={index} />
            {!trackedFile && (
              <LegacyActionIcon
                color="red"
                onClick={() => handleRemoveFile(versionFile.uuid)}
                loading={deleteFileMutation.isLoading}
                style={{ marginTop: 18 }}
              >
                <IconTrash size={16} />
              </LegacyActionIcon>
            )}
          </Group>
        )}
        {versionFile.isUploading && !trackedFile && (
          <LegacyActionIcon
            color="red"
            onClick={() => handleRemoveFile(versionFile.uuid)}
            loading={deleteFileMutation.isLoading}
          >
            <IconTrash size={16} />
          </LegacyActionIcon>
        )}
      </Group>
      {trackedFile && (
        <Card.Section>
          <TrackedFile uuid={versionFile.uuid} />
        </Card.Section>
      )}
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

// Compact inline label for selects
function SelectLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      size="xs"
      fw={500}
      c="dimmed"
      tt="uppercase"
      style={{ letterSpacing: 0.5, fontSize: 11 }}
      mb={2}
    >
      {children}
    </Text>
  );
}

// Inline compact edit form with small selects
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
          isRequired: versionFile.isRequired ?? undefined,
        },
      });
    }
  };

  const filterByFileExtension = (value: ModelFileType) => {
    const extension = getFileExtension(versionFile.name);

    switch (extension) {
      case 'ckpt':
      case 'safetensors':
      case 'pt':
      case 'gguf':
      case 'onnx':
        return ['Model', 'Negative', 'VAE', 'UNet', 'CLIPVision', 'ControlNet'].includes(value);
      case 'zip':
        return ['Training Data', 'Archive', 'Model'].includes(value);
      case 'yml':
      case 'yaml':
      case 'json':
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
      isRequired: initialFile.isRequired,
    });
  };

  const canManualSave = !!versionFile.id && !isEqual(versionFile, initialFile);

  const isCheckpoint = versionFile.type === 'Model' && versionFile.modelType === 'Checkpoint';
  const isComponentFileByType =
    versionFile.type &&
    componentFileTypes.includes(versionFile.type as (typeof componentFileTypes)[number]);
  const isComponentFile = !!isComponentFileByType;
  const isGguf = versionFile.name.endsWith('.gguf');
  const isZip = versionFile.name.endsWith('.zip');

  // Show precision/quant/format for model checkpoint files AND component files
  const showMetadataSelects = isCheckpoint || isComponentFile;

  return (
    <Group gap="xs" align="flex-end" wrap="nowrap">
      <div>
        <SelectLabel>Type</SelectLabel>
        <Select
          allowDeselect={false}
          size="xs"
          w={110}
          placeholder="Type"
          error={error?.type?._errors[0]}
          data={fileTypes.filter(filterByFileExtension).map((x) => ({
            label: getDisplayName(x === 'Model' ? versionFile.modelType ?? x : x),
            value: x,
          }))}
          value={versionFile.type ?? null}
          onChange={(value) => {
            const newType = value as ModelFileType | null;
            updateFile(versionFile.uuid, {
              type: newType,
              size: null,
              fp: null,
              isRequired: newType
                ? (componentFileTypes as readonly string[]).includes(newType)
                : false,
            });
          }}
        />
      </div>

      {showMetadataSelects && (
        <>
          {isZip && (
            <div>
              <SelectLabel>Format</SelectLabel>
              <Select
                allowDeselect={false}
                size="xs"
                w={90}
                placeholder="Format"
                error={error?.format?._errors[0]}
                data={zipModelFileTypes.map((x) => ({ label: x, value: x }))}
                value={versionFile.format ?? null}
                onChange={(value) => {
                  updateFile(versionFile.uuid, { format: value as ZipModelFileType | null });
                }}
              />
            </div>
          )}

          {isGguf ? (
            <div>
              <SelectLabel>Quant</SelectLabel>
              <Select
                allowDeselect={false}
                size="xs"
                w={90}
                placeholder="Quant"
                error={error?.quantType?._errors[0]}
                data={constants.modelFileQuantTypes}
                value={versionFile.quantType ?? null}
                onChange={(value) => {
                  updateFile(versionFile.uuid, {
                    quantType: value as ModelFileQuantType | null,
                  });
                }}
              />
            </div>
          ) : (
            <div>
              <SelectLabel>Precision</SelectLabel>
              <Select
                allowDeselect={false}
                size="xs"
                w={85}
                placeholder="fp16"
                error={error?.fp?._errors[0]}
                data={constants.modelFileFp}
                value={versionFile.fp ?? null}
                onChange={(value) => {
                  updateFile(versionFile.uuid, { fp: value as ModelFileFp | null });
                }}
              />
            </div>
          )}

          {isCheckpoint && (
            <div>
              <SelectLabel>Size</SelectLabel>
              <Select
                allowDeselect={false}
                size="xs"
                w={80}
                placeholder="Size"
                error={error?.size?._errors[0]}
                data={constants.modelFileSizes.map((size) => ({
                  label: startCase(size),
                  value: size,
                }))}
                value={versionFile.size ?? null}
                onChange={(value) => {
                  updateFile(versionFile.uuid, { size: value as 'full' | 'pruned' | null });
                }}
              />
            </div>
          )}
        </>
      )}

      {canManualSave && (
        <>
          <Button
            size="xs"
            variant="default"
            onClick={handleReset}
            disabled={isLoading}
            style={{ marginBottom: 0 }}
          >
            Reset
          </Button>
          <Button
            size="xs"
            loading={isLoading}
            variant="filled"
            onClick={handleSave}
            style={{ marginBottom: 0 }}
          >
            Save
          </Button>
        </>
      )}
    </Group>
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
