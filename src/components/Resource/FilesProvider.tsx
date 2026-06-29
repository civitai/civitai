import { Anchor, Stack, Text } from '@mantine/core';
import { randomId } from '@mantine/hooks';
import { hideNotification, showNotification } from '@mantine/notifications';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import * as z from 'zod';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { LinkedComponent } from '~/server/schema/model-file.schema';
import type { ModelFileType } from '~/server/common/constants';
import { componentFileTypes, constants } from '~/server/common/constants';
import { UploadType } from '~/server/common/enums';
import type { ModelVersionById } from '~/server/controllers/model-version.controller';
import { modelFileMetadataSchema } from '~/server/schema/model-file.schema';
import type { ModelUpsertInput } from '~/server/schema/model.schema';
import { ModelStatus, ModelType, ModelUsageControl } from '~/shared/utils/prisma/enums';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { getPrimaryFileTypes, primaryFileTypesByModelType } from '~/utils/file-display-helpers';
import {
  getModelFileFormat,
  inferGgufQuantType,
  inferSafetensorsPrecision,
} from '~/utils/file-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { bytesToKB } from '~/utils/number-helpers';
import { getFileExtension, getModelUrl } from '~/utils/string-helpers';
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
  usageControl?: ModelUsageControl | null;
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
  version?: Pick<
    Partial<ModelVersionById>,
    'id' | 'files' | 'baseModel' | 'linkedComponents' | 'usageControl'
  >;
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

  // Latest files snapshot for async callbacks (upload completion reads the most
  // recent metadata the user has set, not what was present when upload started).
  const filesRef = useRef(files);
  filesRef.current = files;
  // Tracks files whose byte-upload has already been kicked off so the auto-start
  // effect doesn't start the same file twice across renders.
  const startedUploadsRef = useRef<Set<string>>(new Set());

  const handleUpdateFile = (uuid: string, file: Partial<FileFromContextProps>) => {
    setFiles((state) => state.map((x) => (x.uuid === uuid ? { ...x, ...file } : x)));
  };

  const removeFile = (uuid: string) => {
    startedUploadsRef.current.delete(uuid);
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
            href={getModelUrl({ modelId, modelName: model?.name, modelVersionId })}
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
    if (modelVersionId) {
      await queryUtils.modelVersion.getById.invalidate({
        id: modelVersionId,
        withFiles: true,
      });
      await queryUtils.modelVersion.getByIdForEdit.invalidate({
        id: modelVersionId,
        withFiles: true,
      });
    }
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

    // External-generation versions (mod-only, routed via external engines) intentionally
    // ship without files; skip the component-count requirement for them.
    const isExternalGeneration = version?.usageControl === ModelUsageControl.ExternalGeneration;

    // Check component-only model constraint (needs access to linkedComponents).
    // Skip for archive-primary model types (Workflows/Poses/Wildcards/Other) — their main file
    // is an archive/config, so they don't fit the "component-only" concept.
    if (!isExternalGeneration && (!model?.type || !archivePrimaryModelTypes.includes(model.type))) {
      const primaryTypes = getPrimaryFileTypes(model?.type);
      const modelFiles = files.filter(
        (f) => f.type && (primaryTypes as readonly string[]).includes(f.type)
      );
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
                  href={getModelUrl({
                    modelId: model?.id ?? 0,
                    modelName: model?.name,
                    modelVersionId: result.modelVersion.id,
                  })}
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
      await queryUtils.modelVersion.getByIdForEdit.invalidate({
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
    // For Additional Components (skipInference), we can't reliably tell what kind
    // of component a weight file is, so we pick a safe default from the section's
    // allow-list so the upload can start immediately — the user refines the type
    // after it finishes.
    const additionalTypes =
      dropzoneOptionsByModelType[model?.type ?? 'Checkpoint'].additional.fileTypes;
    const toUpload = files.map((file) => {
      const inferredType = skipInference
        ? defaultType ?? inferComponentFileType(file.name, additionalTypes)
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

    // Auto-detect file metadata from the header so the user doesn't have to pick
    // it manually: precision (fp) for safetensors, quant type for GGUF. Runs in
    // the background; the upload-completion handler reads the latest value via
    // filesRef, so it's fine if this resolves after the byte upload has started.
    for (const item of toUpload) {
      if (!item.file) continue;
      const fileName = item.file.name.toLowerCase();
      if (fileName.endsWith('.safetensors') || fileName.endsWith('.sft')) {
        inferSafetensorsPrecision(item.file)
          .then((fp) => {
            if (fp) handleUpdateFile(item.uuid, { fp });
          })
          .catch(() => null);
      } else if (fileName.endsWith('.gguf')) {
        inferGgufQuantType(item.file)
          .then((quantType) => {
            if (quantType) handleUpdateFile(item.uuid, { quantType });
          })
          .catch(() => null);
      }
    }
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
        async ({ meta, size: uploadedSize, backend, ...result }) => {
          // `uploadedSize` is the byte size of the upload (renamed to avoid
          // shadowing the `size` model-metadata field, which is 'full' | 'pruned').
          const start = meta as {
            versionId: number;
            uuid: string;
            size?: FileFromContextProps['size'];
            fp?: FileFromContextProps['fp'];
            format?: FileFromContextProps['format'];
            quantType?: FileFromContextProps['quantType'];
            isRequired?: FileFromContextProps['isRequired'];
          };
          const { versionId, uuid } = start;
          if (!versionId) return;
          // Read the latest metadata the user (or precision auto-detect) has set
          // during the upload, falling back to what was captured at upload start.
          // This is what makes auto-starting the upload on drop safe: the bytes go
          // up immediately while type/precision can still be edited until save.
          const latest = filesRef.current.find((x) => x.uuid === uuid);
          const fileType = latest?.type ?? type;
          if (!fileType) return;
          const metadata = {
            size: latest?.size ?? start.size ?? undefined,
            fp: latest?.fp ?? start.fp ?? undefined,
            format: latest?.format ?? start.format ?? undefined,
            quantType: latest?.quantType ?? start.quantType ?? undefined,
            isRequired: latest?.isRequired ?? start.isRequired ?? undefined,
          };
          try {
            const saved = await createFileMutation.mutateAsync({
              ...result,
              sizeKB: bytesToKB(uploadedSize),
              modelVersionId: versionId,
              type: fileType,
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

  // Auto-start byte uploads as soon as a file has enough info to upload (a type
  // and a File object). The slow byte transfer overlaps with the user filling in
  // metadata; the file record is saved on completion with the latest metadata.
  // Failed uploads are NOT auto-restarted (their uuid stays in the started set) —
  // the user retries explicitly via the file's retry button.
  useEffect(() => {
    if (!version?.id) return;
    for (const file of files) {
      if (
        file.isPending &&
        file.file &&
        file.type &&
        !file.id &&
        !file.isUploading &&
        !startedUploadsRef.current.has(file.uuid)
      ) {
        startedUploadsRef.current.add(file.uuid);
        void handleUpload(file);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, version?.id]);

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
        usageControl: version?.usageControl,
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


/**
 * Pick a default type for a file dropped into the Additional Components section so
 * its upload can start immediately. We can't reliably tell a VAE from a Text
 * Encoder by the file alone, so weight/unknown files default to the generic
 * "Other" — the user refines it after the upload finishes. The chosen type is
 * always one the section actually allows.
 */
function inferComponentFileType(
  fileName: string,
  allowedTypes: ModelFileType[]
): ModelFileType | undefined {
  const ext = getFileExtension(fileName);
  const pick = (...candidates: ModelFileType[]) =>
    candidates.find((type) => allowedTypes.includes(type));
  switch (ext) {
    case 'yaml':
    case 'yml':
    case 'json':
    case 'txt':
      return pick('Config', 'Other');
    case 'zip':
      return pick('Training Data', 'Archive', 'Other');
    default:
      // weights (.safetensors/.ckpt/.pt/.sft/.bin/.gguf/.onnx) and anything else
      return pick('Other') ?? allowedTypes[0];
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
const configExts = ['.yaml', '.yml', '.json', '.txt'];
const archiveExts = ['.zip'];

// Primary-file cap for weights-bearing types — room for multiple fp precisions
// (fp16/fp32/fp8/bf16) plus gguf quant variants (Q2_K…Q8_0) of the same model.
const mainModelMaxFiles = 20;

const dropzoneOptionsByModelType: Record<ModelType, DropzoneOptions> = {
  Checkpoint: {
    primary: {
      extensions: [...ggufExts, '.onnx'],
      fileTypes: [...primaryFileTypesByModelType.Checkpoint],
      maxFiles: mainModelMaxFiles,
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
        'Enhancement LoRA',
        'Other',
      ],
      maxFiles: 6,
    },
  },
  LORA: {
    primary: {
      extensions: ggufExts,
      fileTypes: [...primaryFileTypesByModelType.LORA],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...modelExts, ...configExts, ...archiveExts],
      fileTypes: [
        'Text Encoder',
        'Config',
        'Training Data',
        'UNet',
        'Diffusion Model',
        'CLIPVision',
        'Enhancement LoRA',
        'Other',
      ],
      maxFiles: 5,
    },
  },
  DoRA: {
    primary: {
      extensions: ggufExts,
      fileTypes: [...primaryFileTypesByModelType.DoRA],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...modelExts, ...configExts, ...archiveExts],
      fileTypes: [
        'Text Encoder',
        'Config',
        'Training Data',
        'UNet',
        'Diffusion Model',
        'CLIPVision',
        'Enhancement LoRA',
        'Other',
      ],
      maxFiles: 5,
    },
  },
  LoCon: {
    primary: {
      extensions: ggufExts,
      fileTypes: [...primaryFileTypesByModelType.LoCon],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...modelExts, ...configExts, ...archiveExts],
      fileTypes: [
        'Text Encoder',
        'Config',
        'Training Data',
        'UNet',
        'Diffusion Model',
        'CLIPVision',
        'Enhancement LoRA',
        'Other',
      ],
      maxFiles: 5,
    },
  },
  TextualInversion: {
    primary: {
      extensions: modelExts,
      fileTypes: [...primaryFileTypesByModelType.TextualInversion],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...archiveExts, ...configExts],
      fileTypes: ['Training Data', 'Config', 'Other'],
      maxFiles: 2,
    },
  },
  Hypernetwork: {
    primary: {
      extensions: modelExts,
      fileTypes: [...primaryFileTypesByModelType.Hypernetwork],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...archiveExts, ...configExts, ...modelExts],
      fileTypes: ['Training Data', 'Config', 'Other'],
      maxFiles: 2,
    },
  },
  AestheticGradient: {
    primary: {
      extensions: modelExts,
      fileTypes: [...primaryFileTypesByModelType.AestheticGradient],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...archiveExts, ...configExts, ...modelExts],
      fileTypes: ['Training Data', 'Config', 'Other'],
      maxFiles: 2,
    },
  },
  Controlnet: {
    primary: {
      extensions: ggufExts,
      fileTypes: [...primaryFileTypesByModelType.Controlnet],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Archive', 'Config', 'Other'],
      maxFiles: 2,
    },
  },
  MotionModule: {
    primary: {
      extensions: [...modelExts, '.onnx'],
      fileTypes: [...primaryFileTypesByModelType.MotionModule],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Archive', 'Config', 'Other'],
      maxFiles: 1,
    },
  },
  Detection: {
    primary: {
      extensions: ['.pt', '.safetensors'],
      fileTypes: [...primaryFileTypesByModelType.Detection],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive', 'Other'],
      maxFiles: 1,
    },
  },
  Upscaler: {
    primary: {
      extensions: ggufExts,
      fileTypes: [...primaryFileTypesByModelType.Upscaler],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive', 'Other'],
      maxFiles: 1,
    },
  },
  VAE: {
    primary: {
      extensions: ggufExts,
      fileTypes: [...primaryFileTypesByModelType.VAE],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive', 'Other'],
      maxFiles: 1,
    },
  },
  TextEncoder: {
    primary: {
      extensions: ggufExts,
      fileTypes: [...primaryFileTypesByModelType.TextEncoder],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive', 'Other'],
      maxFiles: 1,
    },
  },
  UNet: {
    primary: {
      extensions: ggufExts,
      fileTypes: [...primaryFileTypesByModelType.UNet],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive', 'Other'],
      maxFiles: 1,
    },
  },
  CLIPVision: {
    primary: {
      extensions: ggufExts,
      fileTypes: [...primaryFileTypesByModelType.CLIPVision],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive', 'Other'],
      maxFiles: 1,
    },
  },
  VisionLanguage: {
    primary: {
      extensions: [...ggufExts, '.onnx'],
      fileTypes: [...primaryFileTypesByModelType.VisionLanguage],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...configExts, ...archiveExts, ...ggufExts],
      fileTypes: ['VAE', 'Config', 'Training Data', 'CLIPVision', 'Text Encoder', 'Other'],
      maxFiles: 6,
    },
  },
  Poses: {
    primary: {
      extensions: [...archiveExts, ...configExts],
      fileTypes: [...primaryFileTypesByModelType.Poses],
      maxFiles: 1,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive', 'Other'],
      maxFiles: 1,
    },
  },
  Wildcards: {
    primary: {
      extensions: [...archiveExts, ...configExts],
      fileTypes: [...primaryFileTypesByModelType.Wildcards],
      maxFiles: 1,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive', 'Other'],
      maxFiles: 1,
    },
  },
  Workflows: {
    primary: {
      extensions: [...archiveExts, ...configExts],
      fileTypes: [...primaryFileTypesByModelType.Workflows],
      maxFiles: 1,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive', 'Other'],
      maxFiles: 1,
    },
  },
  Other: {
    primary: {
      extensions: [...archiveExts, ...configExts, ...ggufExts],
      fileTypes: [...primaryFileTypesByModelType.Other],
      maxFiles: mainModelMaxFiles,
    },
    additional: {
      extensions: [...configExts, ...archiveExts],
      fileTypes: ['Config', 'Archive', 'Other'],
      maxFiles: 1,
    },
  },
};
