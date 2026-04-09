import { Anchor, Stack, Text } from '@mantine/core';
import { randomId } from '@mantine/hooks';
import { hideNotification, showNotification } from '@mantine/notifications';
import { createContext, useContext, useState } from 'react';
import * as z from 'zod';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { LinkedComponent } from '~/server/schema/model-file.schema';
import type { ModelFileType } from '~/server/common/constants';
import { componentFileTypes, constants } from '~/server/common/constants';
import { UploadType } from '~/server/common/enums';
import type { ModelVersionById } from '~/server/controllers/model-version.controller';
import { modelFileMetadataSchema } from '~/server/schema/model-file.schema';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import { ModelStatus, ModelType } from '~/shared/utils/prisma/enums';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { getModelFileFormat } from '~/utils/file-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { bytesToKB } from '~/utils/number-helpers';
import { getFileExtension } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

type ZodErrorSchema = { _errors: string[] };
type SchemaError = {
  type?: ZodErrorSchema;
  size?: ZodErrorSchema;
  fp?: ZodErrorSchema;
  format?: ZodErrorSchema;
  quantType?: ZodErrorSchema;
};

export type FileFromContextProps = {
  id?: number;
  name: string;
  modelType?: ModelType | null;
  type?: ModelFileType | null;
  sizeKB?: number;
  size?: 'full' | 'pruned' | null;
  fp?: ModelFileFp | null;
  format?: ModelFileFormat | null;
  quantType?: ModelFileQuantType | null;
  isRequired?: boolean | null;
  versionId?: number;
  file?: File;
  uuid: string;
  isPending?: boolean;
  isUploading?: boolean;
  status: 'pending' | 'uploading' | 'error' | 'aborted' | 'success';
};

type FilesContextState = {
  hasPending: boolean;
  errors: SchemaError[] | null;
  files: FileFromContextProps[];
  linkedComponents: LinkedComponent[];
  modelId?: number;
  baseModel?: string;
  dropzoneConfig: DropzoneOptions;
  onDrop: (files: File[], defaultType?: ModelFileType, skipInference?: boolean) => void;
  startUpload: () => Promise<void>;
  retry: (uuid: string) => Promise<void>;
  updateFile: (uuid: string, file: Partial<FileFromContextProps>) => void;
  removeFile: (uuid: string) => void;
  validationCheck: () => boolean;
  addLinkedComponent: (
    component: LinkedComponent | Omit<LinkedComponent, 'fileId' | 'fileName' | 'sizeKB'>
  ) => Promise<void>;
  removeLinkedComponent: (versionId: number) => void;
};

type FilesProviderProps = {
  model?: Partial<ModelUpsertInput>;
  version?: Pick<Partial<ModelVersionById>, 'id' | 'files' | 'baseModel' | 'linkedComponents'>;
  children: React.ReactNode;
};

const FilesContext = createContext<FilesContextState | null>(null);
export const useFilesContext = () => {
  const context = useContext(FilesContext);
  if (!context) throw new Error('FilesContext not in tree');
  return context;
};

export function FilesProvider({ model, version, children }: FilesProviderProps) {
  const queryUtils = trpc.useUtils();
  const upload = useS3UploadStore((state) => state.upload);
  const setItems = useS3UploadStore((state) => state.setItems);

  const [errors, setErrors] = useState<SchemaError[] | null>(null);
  const [files, setFiles] = useState<FileFromContextProps[]>(() => {
    const initialFiles = (version?.files?.map((file) => ({
      id: file.id,
      name: file.name,
      type: file.type as ModelFileType,
      sizeKB: file.sizeKB,
      size: file.metadata?.size,
      fp: file.metadata?.fp,
      format: file.metadata?.format,
      quantType: file.metadata?.quantType,
      isRequired: file.metadata?.isRequired ?? null,
      versionId: version.id,
      uuid: randomId(),
      modelType: model?.type ?? null,
    })) ?? []) as FileFromContextProps[];
    const uploading = useS3UploadStore
      .getState()
      .items.filter((x) => x.meta?.versionId === version?.id)
      .map((item) => ({
        name: item.name,
        sizeKB: bytesToKB(item.size),
        file: item.file,
        // persisted through meta
        uuid: item.meta?.uuid ?? randomId(),
        type: item.meta?.type,
        size: item.meta?.size,
        fp: item.meta?.fp,
        format: item.meta?.format,
        versionId: item.meta?.versionId,
      })) as FileFromContextProps[];
    return [...initialFiles, ...uploading].filter(isDefined);
  });

  const handleUpdateFile = (uuid: string, file: Partial<FileFromContextProps>) => {
    setFiles((state) => state.map((x) => (x.uuid === uuid ? { ...x, ...file } : x)));
  };

  const removeFile = (uuid: string) => {
    setFiles((state) => state.filter((x) => x.uuid !== uuid));
  };

  // Linked components state (components from other models on Civitai)
  const [linkedComponents, setLinkedComponents] = useState<LinkedComponent[]>(
    () =>
      version?.linkedComponents?.map((c) => ({
        ...c,
        componentType: c.componentType as ModelFileComponentType,
        isRequired: c.isRequired ?? true,
      })) ?? []
  );

  const setLinkedComponentsMutation = trpc.modelVersion.setLinkedComponents.useMutation({
    onError(error) {
      showErrorNotification({
        title: 'Failed to save linked component',
        error: new Error(error.message),
      });
    },
  });

  const addLinkedComponentMutation = trpc.modelVersion.addLinkedComponent.useMutation({
    onError(error) {
      showErrorNotification({
        title: 'Failed to link component',
        error: new Error(error.message),
      });
    },
  });

  const persistLinkedComponents = (components: LinkedComponent[]) => {
    if (!version?.id) return;
    setLinkedComponentsMutation.mutate({
      id: version.id,
      components: components.map((c) => ({
        id: c.recommendedResourceId,
        resourceId: c.versionId,
        settings: {
          isLinkedComponent: true as const,
          componentType: c.componentType,
          fileId: c.fileId,
          modelId: c.modelId,
          modelName: c.modelName,
          versionName: c.versionName,
          fileName: c.fileName,
          isRequired: c.isRequired ?? true,
        },
      })),
    });
  };

  const addLinkedComponent = async (
    component: LinkedComponent | Omit<LinkedComponent, 'fileId' | 'fileName' | 'sizeKB'>
  ) => {
    // If component already has fileId (e.g., toggling isRequired on existing), use bulk persist
    if ('fileId' in component && component.fileId) {
      const updated = [
        ...linkedComponents.filter((c) => c.versionId !== component.versionId),
        { ...component, isRequired: component.isRequired ?? true } as LinkedComponent,
      ];
      setLinkedComponents(updated);
      persistLinkedComponents(updated);
      return;
    }

    // New link: use the addLinkedComponent mutation which resolves file data server-side
    if (!version?.id) return;
    const result = await addLinkedComponentMutation.mutateAsync({
      id: version.id,
      targetVersionId: component.versionId,
      componentType: component.componentType,
      modelId: component.modelId,
      modelName: component.modelName,
      versionName: component.versionName,
      isRequired: component.isRequired ?? true,
    });

    const enriched: LinkedComponent = {
      recommendedResourceId: result.recommendedResourceId,
      componentType: result.componentType as ModelFileComponentType,
      modelId: result.modelId,
      modelName: result.modelName,
      versionId: result.versionId,
      versionName: result.versionName,
      fileId: result.fileId,
      fileName: result.fileName,
      sizeKB: result.sizeKB,
      fileType: result.fileType,
      fileMetadata: result.fileMetadata ?? undefined,
      isRequired: result.isRequired,
    };

    setLinkedComponents((prev) => [
      ...prev.filter((c) => c.versionId !== component.versionId),
      enriched,
    ]);
  };

  const removeLinkedComponent = (versionId: number) => {
    const updated = linkedComponents.filter((c) => c.versionId !== versionId);
    setLinkedComponents(updated);
    persistLinkedComponents(updated);
  };

  const publishModelMutation = trpc.model.publish.useMutation({
    async onSuccess(_, variables) {
      hideNotification('publishing-version');
      const modelId = variables.id;
      const modelVersionId = variables.versionIds?.[0];
      showPublishedNotification(modelId, modelVersionId);
    },
    onError(error) {
      hideNotification('publishing-version');
      showErrorNotification({
        title: 'Failed to publish version',
        error: new Error(error.message),
      });
    },
  });
  const publishVersionMutation = trpc.modelVersion.publish.useMutation({
    async onSuccess(results) {
      hideNotification('publishing-version');
      if (results) showPublishedNotification(results.modelId, results.id);
    },
    onError(error) {
      hideNotification('publishing-version');
      showErrorNotification({
        title: 'Failed to publish version',
        error: new Error(error.message),
      });
    },
  });

  const showPublishedNotification = async (modelId: number, modelVersionId?: number) => {
    const pubNotificationId = `version-published-${modelVersionId}`;
    showNotification({
      id: pubNotificationId,
      title: 'Version published',
      color: 'green',
      styles: { root: { alignItems: 'flex-start' } },
      message: (
        <Stack gap={4}>
          <Text size="sm" c="dimmed">
            Your version has been published and is now available to the public.
          </Text>
          <Link
            legacyBehavior
            href={`/models/${modelId}?modelVersionId=${modelVersionId}`}
            passHref
          >
            <Anchor size="sm" onClick={() => hideNotification(pubNotificationId)}>
              Go to model
            </Anchor>
          </Link>
        </Stack>
      ),
    });

    await queryUtils.model.getById.invalidate({ id: modelId });
    if (modelVersionId)
      await queryUtils.modelVersion.getById.invalidate({
        id: modelVersionId,
        withFiles: true,
      });
  };

  const checkValidation = () => {
    setErrors(null);

    const validation = metadataSchema.safeParse(files);
    if (!validation.success) {
      const errors = validation.error.format() as unknown as Array<{
        [k: string]: ZodErrorSchema;
      }>;
      setErrors(errors);

      // Build user-friendly error messages per file
      const missingFields: string[] = [];
      errors.forEach((err, i) => {
        if (!err) return;
        const fileName = files[i]?.name ?? `File ${i + 1}`;
        const fields: string[] = [];
        if (err.size?._errors?.length) fields.push('model size');
        if (err.fp?._errors?.length) fields.push('precision');
        if (err.quantType?._errors?.length) fields.push('quant type');
        if (err.type?._errors?.length) fields.push('file type');
        if (fields.length) missingFields.push(`${fileName}: missing ${fields.join(', ')}`);
      });
      if (missingFields.length) {
        showErrorNotification({
          title: 'Missing required fields',
          error: new Error(missingFields.join('\n')),
        });
      }

      return false;
    }

    // Check component-only model constraint (needs access to linkedComponents)
    const modelFiles = files.filter((f) => f.type && ['Model', 'Pruned Model'].includes(f.type));
    if (modelFiles.length === 0) {
      const uploadedRequiredComponents = files.filter(
        (f) =>
          f.type &&
          (componentFileTypes as readonly string[]).includes(f.type) &&
          f.isRequired !== false
      );
      const requiredLinkedComponents = linkedComponents.filter((c) => c.isRequired !== false);
      const totalComponents = uploadedRequiredComponents.length + requiredLinkedComponents.length;
      if (totalComponents < 2) {
        showErrorNotification({
          title: 'Insufficient components',
          error: new Error(
            'Component-only models (without a main model file) require at least 2 required components'
          ),
        });
        return false;
      }
    }

    const noConflicts = checkConflictingFiles(files);
    if (!noConflicts) {
      showErrorNotification({
        title: 'Duplicate file types',
        error: new Error(
          'There are multiple files with the same type and size, please adjust your files'
        ),
      });
    }
    return noConflicts;
  };

  const createFileMutation = trpc.modelFile.create.useMutation({
    async onSuccess(result) {
      const hasPublishedPosts = result.modelVersion._count.posts > 0;
      const isVersionPublished = result.modelVersion.status === ModelStatus.Published;
      const { uploading } = useS3UploadStore
        .getState()
        .getStatus((item) => item.meta?.versionId === result.modelVersion.id);
      const stillUploading = uploading > 0;

      const notificationId = `upload-finished-${result.id}`;
      showNotification({
        id: notificationId,
        autoClose: stillUploading,
        color: 'green',
        title: `Finished uploading ${result.name}`,
        styles: { root: { alignItems: 'flex-start' } },
        message: !stillUploading ? (
          <Stack gap={4}>
            {isVersionPublished ? (
              <>
                <Text size="sm" c="dimmed">
                  All files finished uploading.
                </Text>
                <Link
                  href={`/models/${model?.id}?modelVersionId=${result.modelVersion.id}`}
                  passHref
                  legacyBehavior
                >
                  <Anchor size="sm" onClick={() => hideNotification(notificationId)}>
                    Go to model
                  </Anchor>
                </Link>
              </>
            ) : hasPublishedPosts ? (
              <>
                <Text size="sm" c="dimmed">
                  {`Your files have finished uploading, let's publish this version.`}
                </Text>
                <Text
                  c="blue.4"
                  size="sm"
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    hideNotification(notificationId);

                    showNotification({
                      id: 'publishing-version',
                      message: 'Publishing...',
                      loading: true,
                    });

                    if (model?.status !== ModelStatus.Published)
                      publishModelMutation.mutate({
                        id: model?.id as number,
                        versionIds: [result.modelVersion.id],
                      });
                    else publishVersionMutation.mutate({ id: result.modelVersion.id });
                  }}
                >
                  Publish it
                </Text>
              </>
            ) : (
              <>
                <Text size="sm" c="dimmed">
                  Your files have finished uploading, but you still need to add a post.
                </Text>
                <Link
                  href={`/models/${model?.id}/model-versions/${result.modelVersion.id}/wizard?step=3`}
                  passHref
                  legacyBehavior
                >
                  <Anchor size="sm" onClick={() => hideNotification(notificationId)}>
                    Finish setup
                  </Anchor>
                </Link>
              </>
            )}
          </Stack>
        ) : undefined,
      });

      await queryUtils.modelVersion.getById.invalidate({
        id: result.modelVersion.id,
        withFiles: true,
      });
      if (model) await queryUtils.model.getById.invalidate({ id: model.id });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to save file',
        reason: 'Could not save file, please try again.',
        error: new Error(error.message),
      });
    },
  });

  const onDrop = (files: File[], defaultType?: ModelFileType, skipInference?: boolean) => {
    const toUpload = files.map((file) => {
      const inferredType = skipInference
        ? defaultType
        : defaultType ?? inferFileType(file.name, model?.type);
      return {
        name: file.name,
        versionId: version?.id,
        modelType: model?.type,
        file,
        status: 'pending',
        sizeKB: bytesToKB(file.size),
        uuid: randomId(),
        isPending: true,
        type: inferredType,
        isRequired: inferredType
          ? (componentFileTypes as readonly string[]).includes(inferredType)
          : false,
      };
    }) as FileFromContextProps[];
    setFiles((state) => [...state, ...toUpload]);
  };

  const handleUpload = async ({
    type,
    size,
    fp,
    format,
    quantType,
    isRequired,
    versionId,
    file,
    uuid,
  }: FileFromContextProps) => {
    if (!file || !type) return;

    setFiles((state) =>
      state.map((x) => (x.uuid === uuid ? { ...x, isPending: false, isUploading: true } : x))
    );

    try {
      return await upload(
        {
          file,
          type: type === 'Model' ? UploadType.Model : UploadType.Default,
          meta: { versionId, type, size, fp, format, quantType, isRequired, uuid },
        },
        async ({ meta, size, backend, ...result }) => {
          const { versionId, type, uuid, ...metadata } = meta as {
            versionId: number;
            type: ModelFileType;
            uuid: string;
          };
          if (versionId) {
            try {
              const saved = await createFileMutation.mutateAsync({
                ...result,
                sizeKB: bytesToKB(size),
                modelVersionId: versionId,
                type,
                metadata,
                ...(backend === 'b2' ? { backend, s3Path: result.key } : {}),
              });
              setItems((items) => items.filter((x) => x.uuid !== result.uuid));
              setFiles((state) =>
                state.map((x) => (x.uuid === uuid ? { ...x, id: saved.id, isUploading: false } : x))
              );
            } catch (e: unknown) {
              showErrorNotification({
                title: 'Failed to save file',
                error: e as Error,
              });
            }
          }
        }
      );
    } catch (e) {
      showErrorNotification({
        title: 'Failed to upload file',
        error: e as Error,
      });

      setFiles((state) =>
        state.map((x) => (x.uuid === uuid ? { ...x, isPending: true, isUploading: false } : x))
      );
    }
  };

  const startUpload = async () => {
    const toUpload = files.filter((x) => x.isPending && !!x.file);

    if (!checkValidation()) throw new Error('validation failed');

    await Promise.all(toUpload.map((file) => handleUpload(file)));
  };

  const retry = async (uuid: string) => {
    const file = files.find((x) => x.uuid === uuid);
    if (!file) return;
    await handleUpload(file);
  };

  const dropzoneConfig = dropzoneOptionsByModelType[model?.type ?? 'Checkpoint'];

  return (
    <FilesContext.Provider
      value={{
        files,
        linkedComponents,
        onDrop,
        startUpload,
        errors: errors,
        hasPending: files.some((x) => x.isPending),
        retry,
        updateFile: handleUpdateFile,
        removeFile,
        dropzoneConfig,
        modelId: model?.id,
        baseModel: version?.baseModel ?? undefined,
        validationCheck: checkValidation,
        addLinkedComponent,
        removeLinkedComponent,
      }}
    >
      {children}
    </FilesContext.Provider>
  );
}

const metadataSchema = modelFileMetadataSchema
  .extend({
    versionId: z.number().optional(),
    type: z.enum(constants.modelFileTypes),
    modelType: z.enum(ModelType),
    name: z.string(),
  })
  .refine(
    (data) => (data.type === 'Model' && data.modelType === 'Checkpoint' ? !!data.size : true),
    {
      error: 'Model size is required for model files',
      path: ['size'],
    }
  )
  .refine(
    (data) =>
      data.type === 'Model' && data.modelType === 'Checkpoint' && !data.name.endsWith('.gguf')
        ? !!data.fp
        : true,
    {
      error: 'Floating point is required for model files',
      path: ['fp'],
    }
  )
  .refine((data) => (data.name.endsWith('.gguf') ? !!data.quantType : true), {
    error: 'Quant type is required for GGUF files',
    path: ['quantType'],
  })
  .array();

// TODO.manuel: This is a hacky way to check for duplicates
export const checkConflictingFiles = (files: FileFromContextProps[]) => {
  const conflictCount: Record<string, number> = {};

  files.forEach((item) => {
    const key = [item.size, item.type, item.fp, getModelFileFormat(item.name), item.quantType]
      .filter(Boolean)
      .join('-');
    if (conflictCount[key]) conflictCount[key] += 1;
    else conflictCount[key] = 1;
  });

  return Object.values(conflictCount).every((count) => count === 1);
};

/** Model types whose primary file is an archive/config rather than model weights */
const archivePrimaryModelTypes: ModelType[] = [
  ModelType.Workflows,
  ModelType.Poses,
  ModelType.Wildcards,
  ModelType.Other,
];

/** Infer a default file type from the file extension, using model type for context */
function inferFileType(fileName: string, modelType?: ModelType | null): ModelFileType | undefined {
  const ext = getFileExtension(fileName);
  switch (ext) {
    case 'safetensors':
    case 'ckpt':
    case 'pt':
    case 'bin':
    case 'gguf':
    case 'sft':
    case 'onnx':
      return 'Model';
    case 'zip':
      return modelType && archivePrimaryModelTypes.includes(modelType) ? 'Archive' : undefined;
    case 'yaml':
    case 'yml':
    case 'json':
    case 'txt':
      return 'Config';
    default:
      return undefined;
  }
}

export type DropzoneSection = {
  extensions: string[];
  fileTypes: ModelFileType[];
  maxFiles: number;
};

export type DropzoneOptions = {
  primary: DropzoneSection;
  additional: DropzoneSection;
};

const modelExts = ['.ckpt', '.pt', '.safetensors', '.sft', '.bin'];
const ggufExts = [...modelExts, '.gguf'];
const configExts = ['.yaml', '.yml', '.json'];
const wildcardExts = ['.txt', ...configExts];
const archiveExts = ['.zip'];

const dropzoneOptionsByModelType: Record<ModelType, DropzoneOptions> = {
  Checkpoint: {
    primary: {
      extensions: [...ggufExts, '.onnx'],
      fileTypes: ['Model', 'Pruned Model', 'UNet', 'Diffusion Model'],
      maxFiles: 8,
    },
    additional: {
      extensions: [...configExts, ...archiveExts, ...ggufExts],
      fileTypes: [
        'VAE',
        'Config',
        'Training Data',
        'CLIPVision',
        'ControlNet',
        'Text Encoder',
        'Workflow',
        'Upscaler',
      ],
      maxFiles: 6,
    },
  },
  LORA: {
    primary: { extensions: ggufExts, fileTypes: ['Model', 'Pruned Model'], maxFiles: 3 },
    additional: {
      extensions: [...modelExts, ...configExts, ...archiveExts],
      fileTypes: [
        'Text Encoder',
        'Config',
        'Training Data',
        'UNet',
        'Diffusion Model',
        'CLIPVision',
      ],
      maxFiles: 5,
    },
  },
  DoRA: {
    primary: { extensions: ggufExts, fileTypes: ['Model', 'Pruned Model'], maxFiles: 3 },
    additional: {
      extensions: [...modelExts, ...configExts, ...archiveExts],
      fileTypes: [
        'Text Encoder',
        'Config',
        'Training Data',
        'UNet',
        'Diffusion Model',
        'CLIPVision',
      ],
      maxFiles: 5,
    },
  },
  LoCon: {
    primary: { extensions: ggufExts, fileTypes: ['Model', 'Pruned Model'], maxFiles: 3 },
    additional: {
      extensions: [...modelExts, ...configExts, ...archiveExts],
      fileTypes: [
        'Text Encoder',
        'Config',
        'Training Data',
        'UNet',
        'Diffusion Model',
        'CLIPVision',
      ],
      maxFiles: 5,
    },
  },
  TextualInversion: {
    primary: { extensions: modelExts, fileTypes: ['Model', 'Negative'], maxFiles: 2 },
    additional: {
      extensions: [...archiveExts, ...configExts],
      fileTypes: ['Training Data', 'Config'],
      maxFiles: 2,
    },
  },
  Hypernetwork: {
    primary: { extensions: modelExts, fileTypes: ['Model'], maxFiles: 1 },
    additional: {
      extensions: [...archiveExts, ...configExts, ...modelExts],
      fileTypes: ['Training Data', 'Config'],
      maxFiles: 2,
    },
  },
  AestheticGradient: {
    primary: { extensions: modelExts, fileTypes: ['Model'], maxFiles: 1 },
    additional: {
      extensions: [...archiveExts, ...configExts, ...modelExts],
      fileTypes: ['Training Data', 'Config'],
      maxFiles: 2,
    },
  },
  Controlnet: {
    primary: { extensions: ggufExts, fileTypes: ['Model'], maxFiles: 2 },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Archive', 'Config'],
      maxFiles: 2,
    },
  },
  MotionModule: {
    primary: { extensions: [...modelExts, '.onnx'], fileTypes: ['Model'], maxFiles: 2 },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Archive', 'Config'],
      maxFiles: 1,
    },
  },
  Detection: {
    primary: { extensions: ['.pt', '.safetensors'], fileTypes: ['Model'], maxFiles: 4 },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive'],
      maxFiles: 1,
    },
  },
  Upscaler: {
    primary: { extensions: ggufExts, fileTypes: ['Model'], maxFiles: 1 },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive'],
      maxFiles: 1,
    },
  },
  VAE: {
    primary: { extensions: ggufExts, fileTypes: ['Model'], maxFiles: 1 },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive'],
      maxFiles: 1,
    },
  },
  TextEncoder: {
    primary: { extensions: ggufExts, fileTypes: ['Model'], maxFiles: 1 },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive'],
      maxFiles: 1,
    },
  },
  UNet: {
    primary: { extensions: ggufExts, fileTypes: ['Model'], maxFiles: 1 },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive'],
      maxFiles: 1,
    },
  },
  CLIPVision: {
    primary: { extensions: ggufExts, fileTypes: ['Model'], maxFiles: 1 },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive'],
      maxFiles: 1,
    },
  },
  Poses: {
    primary: {
      extensions: [...archiveExts, ...configExts],
      fileTypes: ['Archive', 'Config'],
      maxFiles: 1,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive'],
      maxFiles: 1,
    },
  },
  Wildcards: {
    primary: {
      extensions: [...archiveExts, ...wildcardExts],
      fileTypes: ['Archive', 'Config'],
      maxFiles: 1,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive'],
      maxFiles: 1,
    },
  },
  Workflows: {
    primary: {
      extensions: [...archiveExts, ...configExts],
      fileTypes: ['Archive', 'Config'],
      maxFiles: 1,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive'],
      maxFiles: 1,
    },
  },
  Other: {
    primary: {
      extensions: [...archiveExts, ...configExts, ...ggufExts],
      fileTypes: ['Archive', 'Config', 'Model'],
      maxFiles: 1,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive'],
      maxFiles: 1,
    },
  },
};
