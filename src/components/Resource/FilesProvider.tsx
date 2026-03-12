import { Anchor, Stack, Text } from '@mantine/core';
import { randomId } from '@mantine/hooks';
import { hideNotification, showNotification } from '@mantine/notifications';
import { createContext, useContext, useState } from 'react';
import * as z from 'zod';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { LinkedComponent } from '~/components/Resource/LinkComponentModal';
import type { ModelFileType } from '~/server/common/constants';
import { constants } from '~/server/common/constants';
import { UploadType } from '~/server/common/enums';
import type { ModelVersionById } from '~/server/controllers/model-version.controller';
import { modelFileMetadataSchema } from '~/server/schema/model-file.schema';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import { ModelStatus, ModelType } from '~/shared/utils/prisma/enums';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { getModelFileFormat } from '~/utils/file-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { bytesToKB } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

type ZodErrorSchema = { _errors: string[] };
type SchemaError = {
  type?: ZodErrorSchema;
  size?: ZodErrorSchema;
  fp?: ZodErrorSchema;
  format?: ZodErrorSchema;
  quantType?: ZodErrorSchema;
  componentType?: ZodErrorSchema;
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
  componentType?: ModelFileComponentType | null;
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
  fileExtensions: string[];
  fileTypes: ModelFileType[];
  maxFiles: number;
  onDrop: (files: File[], defaultType?: ModelFileType) => void;
  startUpload: () => Promise<void>;
  retry: (uuid: string) => Promise<void>;
  updateFile: (uuid: string, file: Partial<FileFromContextProps>) => void;
  removeFile: (uuid: string) => void;
  validationCheck: () => boolean;
  addLinkedComponent: (component: LinkedComponent) => void;
  removeLinkedComponent: (componentType: ModelFileComponentType) => void;
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
      componentType: file.metadata?.componentType,
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
        },
      })),
    });
  };

  const addLinkedComponent = (component: LinkedComponent) => {
    const updated = [
      ...linkedComponents.filter((c) => c.componentType !== component.componentType),
      component,
    ];
    setLinkedComponents(updated);
    persistLinkedComponents(updated);
  };

  const removeLinkedComponent = (componentType: ModelFileComponentType) => {
    const updated = linkedComponents.filter((c) => c.componentType !== componentType);
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
      return false;
    }

    // Check component-only model constraint (needs access to linkedComponents)
    const modelFiles = files.filter((f) => f.type && ['Model', 'Pruned Model'].includes(f.type));
    if (modelFiles.length === 0) {
      const requiredComponentTypes = ['VAE', 'Text Encoder', 'UNet', 'CLIPVision', 'ControlNet'];
      const uploadedComponents = files.filter(
        (f) => f.type && requiredComponentTypes.includes(f.type)
      );
      const totalComponents = uploadedComponents.length + linkedComponents.length;
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

  const onDrop = (files: File[], defaultType?: ModelFileType) => {
    const toUpload = files.map((file) => {
      const inferredType = defaultType ?? inferFileType(file.name);
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
    componentType,
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
          meta: { versionId, type, size, fp, format, quantType, componentType, uuid },
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

  const { acceptedModelFiles, acceptedFileTypes, maxFiles } =
    dropzoneOptionsByModelType[model?.type ?? 'Checkpoint'];

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
        fileExtensions: acceptedFileTypes,
        fileTypes: acceptedModelFiles,
        modelId: model?.id,
        baseModel: version?.baseModel ?? undefined,
        maxFiles,
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
  .refine((data) => (data.type === 'Model' && data.modelType === 'Checkpoint' ? !!data.fp : true), {
    error: 'Floating point is required for model files',
    path: ['fp'],
  })
  .refine((data) => (data.name.endsWith('.gguf') ? !!data.quantType : true), {
    error: 'Quant type is required for GGUF files',
    path: ['quantType'],
  })
  .array();

// TODO.manuel: This is a hacky way to check for duplicates
export const checkConflictingFiles = (files: FileFromContextProps[]) => {
  const conflictCount: Record<string, number> = {};

  files.forEach((item) => {
    const key = [
      item.size,
      item.type,
      item.fp,
      getModelFileFormat(item.name),
      item.quantType,
      item.componentType,
    ]
      .filter(Boolean)
      .join('-');
    if (conflictCount[key]) conflictCount[key] += 1;
    else conflictCount[key] = 1;
  });

  return Object.values(conflictCount).every((count) => count === 1);
};

/** Infer a default file type from the file extension */
function inferFileType(fileName: string): ModelFileType | undefined {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'safetensors':
    case 'ckpt':
    case 'pt':
    case 'bin':
    case 'gguf':
    case 'sft':
    case 'onnx':
      return 'Model';
    case 'yaml':
    case 'yml':
      return 'Config';
    case 'zip':
      return 'Archive';
    default:
      return undefined;
  }
}

type DropzoneOptions = {
  acceptedFileTypes: string[];
  acceptedModelFiles: ModelFileType[];
  maxFiles: number;
};

const dropzoneOptionsByModelType: Record<ModelType, DropzoneOptions> = {
  Checkpoint: {
    acceptedFileTypes: [
      '.ckpt',
      '.pt',
      '.safetensors',
      '.gguf',
      '.sft',
      '.bin',
      '.zip',
      '.yaml',
      '.yml',
      '.onnx',
    ],
    acceptedModelFiles: ['Model', 'Config', 'Training Data'],
    maxFiles: 11,
  },
  MotionModule: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.sft', '.bin', '.onnx'],
    acceptedModelFiles: ['Model'],
    maxFiles: 2,
  },
  LORA: {
    acceptedFileTypes: [
      '.ckpt',
      '.pt',
      '.safetensors',
      '.sft',
      '.gguf',
      '.bin',
      '.zip',
      '.yaml',
      '.yml',
    ],
    acceptedModelFiles: ['Model', 'Text Encoder', 'Training Data'],
    maxFiles: 4,
  },
  DoRA: {
    acceptedFileTypes: [
      '.ckpt',
      '.pt',
      '.safetensors',
      '.sft',
      '.gguf',
      '.bin',
      '.zip',
      '.yaml',
      '.yml',
    ],
    acceptedModelFiles: ['Model', 'Text Encoder', 'Training Data'],
    maxFiles: 4,
  },
  LoCon: {
    acceptedFileTypes: [
      '.ckpt',
      '.pt',
      '.safetensors',
      '.sft',
      '.gguf',
      '.bin',
      '.zip',
      '.yaml',
      '.yml',
    ],
    acceptedModelFiles: ['Model', 'Text Encoder', 'Training Data'],
    maxFiles: 4,
  },
  Detection: {
    acceptedFileTypes: ['.pt'],
    acceptedModelFiles: ['Model'],
    maxFiles: 4,
  },
  TextualInversion: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.sft', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Negative', 'Training Data'],
    maxFiles: 3,
  },
  Hypernetwork: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.sft', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Training Data'],
    maxFiles: 2,
  },
  AestheticGradient: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.sft', '.bin', '.zip'],
    acceptedModelFiles: ['Model', 'Training Data'],
    maxFiles: 2,
  },
  Controlnet: {
    acceptedFileTypes: ['.ckpt', '.pt', '.safetensors', '.gguf', '.sft', '.bin', '.yaml', '.yml'],
    acceptedModelFiles: ['Model', 'Config'],
    maxFiles: 3,
  },
  Upscaler: {
    acceptedFileTypes: ['.ckpt', '.pt', '.gguf', '.safetensors', '.sft', '.bin'],
    acceptedModelFiles: ['Model'],
    maxFiles: 1,
  },
  VAE: {
    acceptedFileTypes: ['.ckpt', '.pt', '.gguf', '.safetensors', '.sft', '.bin'],
    acceptedModelFiles: ['Model'],
    maxFiles: 1,
  },
  Poses: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
  Wildcards: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
  Workflows: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
  Other: { acceptedFileTypes: ['.zip'], acceptedModelFiles: ['Archive'], maxFiles: 1 },
};
