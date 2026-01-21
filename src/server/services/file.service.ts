import type { Prisma } from '@prisma/client';
import { env } from '~/env/server';
import type { ModelFileType } from '~/server/common/constants';
import { constants } from '~/server/common/constants';
import { EntityAccessPermission } from '~/server/common/enums';
import type { BaseFileSchema, GetFilesByEntitySchema } from '~/server/schema/file.schema';
import { getBountyEntryFilteredFiles } from '~/server/services/bountyEntry.service';
import { getVaeFiles } from '~/server/services/model.service';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import {
  ModelFileVisibility,
  ModelModifier,
  ModelType,
  ModelUsageControl,
} from '~/shared/utils/prisma/enums';
import { getDownloadUrl } from '~/utils/delivery-worker';
import { removeEmpty } from '~/utils/object-helpers';
import { filenamize, replaceInsensitive } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { dbRead } from '../db/client';
import { hasEntityAccess } from './common.service';

export const getFilesByEntity = async ({ id, ids, type }: GetFilesByEntitySchema) => {
  if (!id && (!ids || ids.length === 0)) {
    return [];
  }

  const files = await dbRead.file.findMany({
    where: { entityId: ids ? { in: ids } : id, entityType: type },
    select: { id: true, name: true, url: true, sizeKB: true, metadata: true, entityId: true },
  });

  return files.map(({ metadata, ...file }) => ({
    ...file,
    metadata: (metadata as Prisma.JsonObject) ?? {},
  }));
};

export const updateEntityFiles = async ({
  tx,
  entityId,
  entityType,
  files,
  ownRights,
}: {
  tx: Prisma.TransactionClient;
  entityId: number;
  entityType: string;
  files: BaseFileSchema[];
  ownRights: boolean;
}) => {
  const updatedFiles = files.filter((f) => f.id);

  if (updatedFiles.length > 0) {
    await Promise.all(
      updatedFiles.map((file) => {
        return tx.file.update({
          where: { id: file.id },
          data: {
            ...file,
            metadata: { ...(file.metadata ?? {}), ownRights },
          },
        });
      })
    );
  }

  // Delete any files that were removed.
  const deletedFileIds = files.map((x) => x.id).filter(isDefined);

  if (deletedFileIds.length >= 0) {
    await tx.file.deleteMany({
      where: {
        entityId,
        entityType,
        id: { notIn: deletedFileIds },
      },
    });
  }

  const newFiles = files.filter((x) => !x.id);

  if (newFiles.length > 0) {
    // Create any new files.
    await tx.file.createMany({
      data: newFiles.map((file) => ({
        ...file,
        entityId,
        entityType,
        metadata: { ...(file.metadata ?? {}), ownRights },
      })),
    });
  }
};

export const getFileWithPermission = async ({
  fileId,
  userId,
  isModerator,
}: {
  fileId: number;
  userId?: number;
  isModerator?: boolean;
}) => {
  const file = await dbRead.file.findUnique({
    where: { id: fileId },
    select: { url: true, name: true, metadata: true, entityId: true, entityType: true },
  });

  if (!file) return null;

  switch (file.entityType) {
    case 'BountyEntry': {
      const bountyEntryFiles = await getBountyEntryFilteredFiles({
        id: file.entityId,
        userId,
        isModerator,
      });
      if (!bountyEntryFiles.some((x) => x.id === fileId && !!x.url)) {
        return null;
      }

      return file;
    }
    default:
      return file;
  }
};

export const getFileForModelVersion = async ({
  modelVersionId,
  type,
  format,
  size,
  fp,
  user,
  noAuth,
}: {
  modelVersionId: number;
  type?: ModelFileType;
  format?: ModelFileFormat;
  size?: ModelFileSize;
  fp?: ModelFileFp;
  user?: {
    isModerator?: boolean | null;
    id?: number;
    tier?: string;
    filePreferences?: UserFilePreferences;
  };
  noAuth?: boolean;
}): Promise<ModelVersionFileResult> => {
  const modelVersion = await dbRead.modelVersion.findFirst({
    where: { id: modelVersionId },
    select: {
      id: true,
      status: true,
      model: {
        select: {
          id: true,
          name: true,
          type: true,
          publishedAt: true,
          status: true,
          userId: true,
          mode: true,
          nsfw: true,
          availability: true,
          poi: true,
        },
      },
      name: true,
      trainedWords: true,
      earlyAccessEndsAt: true,
      earlyAccessConfig: true,
      createdAt: true,
      vaeId: true,
      requireAuth: true,
      usageControl: true,
    },
  });

  if (!modelVersion) return { status: 'not-found' };

  // disablePoi - Disables downloads for POI resources.
  if (modelVersion.model.poi && modelVersion.model.userId !== user?.id && !user?.isModerator) {
    return { status: 'not-found' };
  }

  const [versionAccess] = await hasEntityAccess({
    entityIds: [modelVersion?.id],
    entityType: 'ModelVersion',
    userId: user?.id,
    isModerator: user?.isModerator ?? undefined,
  });

  const deadline = modelVersion.earlyAccessEndsAt ?? undefined;
  const inEarlyAccess = deadline !== undefined && new Date() < deadline;
  const isDownloadable = modelVersion.usageControl === ModelUsageControl.Download;

  const archived = modelVersion.model.mode === ModelModifier.Archived;
  if (!noAuth && archived) return { status: 'archived' };

  const isMod = user?.isModerator;
  const userId = user?.id;
  const isOwner = !!userId && modelVersion.model.userId === userId;
  const canDownload =
    noAuth ||
    isMod ||
    isOwner ||
    (modelVersion?.model?.status === 'Published' && modelVersion?.status === 'Published');

  if (!canDownload) return { status: 'not-found' };

  if (modelVersion?.usageControl !== ModelUsageControl.Download && !isMod && !isOwner) {
    return { status: 'downloads-disabled' };
  }

  const requireAuth = modelVersion.requireAuth || !env.UNAUTHENTICATED_DOWNLOAD;
  if (requireAuth && !userId) return { status: 'unauthorized' };

  if (!(versionAccess?.hasAccess ?? true)) {
    return { status: 'unauthorized' };
  }

  // Check the early access scenario:
  if (
    inEarlyAccess &&
    (versionAccess.permissions & EntityAccessPermission.EarlyAccessDownload) == 0 &&
    !isMod &&
    !isOwner
  ) {
    return { status: 'early-access', details: { deadline } };
  }

  // Get the correct file
  let file: FileResult | null = null;
  if (type === 'VAE') {
    if (!modelVersion.vaeId) return { status: 'not-found' };
    const vae = await getVaeFiles({ vaeIds: [modelVersion.vaeId] });
    if (!vae.length) return { status: 'not-found' };
    file = vae[0];
  } else {
    const fileWhere: Prisma.ModelFileWhereInput = { modelVersionId };
    if (type) fileWhere.type = type;
    if (!isOwner && !isMod) fileWhere.visibility = ModelFileVisibility.Public;

    // Debug logging for training data downloads
    if (type === 'Training Data') {
      console.log('[getFileForModelVersion] Training data query:', {
        modelVersionId,
        type,
        isOwner,
        isMod,
        userId,
        modelOwnerId: modelVersion.model.userId,
        fileWhere,
      });
    }

    const files = await dbRead.modelFile.findMany({
      where: fileWhere,
      select: {
        id: true,
        url: true,
        name: true,
        overrideName: true,
        type: true,
        metadata: true,
        visibility: true,
        hashes: { select: { hash: true }, where: { type: 'SHA256' } },
      },
    });

    // Debug logging for training data downloads
    if (type === 'Training Data') {
      console.log('[getFileForModelVersion] Training data files found:', {
        modelVersionId,
        filesCount: files.length,
        files: files.map((f) => ({ id: f.id, type: f.type, visibility: f.visibility, url: f.url?.substring(0, 50) })),
      });
    }

    const metadata: FileMetadata = {
      ...user?.filePreferences,
      ...removeEmpty({ format, size, fp }),
    };
    const castedFiles = files as Array<Omit<FileResult, 'metadata'> & { metadata: FileMetadata }>;
    file = getPrimaryFile(castedFiles, { metadata });
  }
  if (!file) return { status: 'not-found' };

  const filename = getDownloadFilename({
    model: modelVersion.model,
    modelVersion,
    file,
  });
  try {
    const { url } = await getDownloadUrl(file.url, filename);
    return {
      status: 'success',
      url,
      fileId: file.id,
      modelId: modelVersion.model.id,
      modelVersionId,
      nsfw: modelVersion.model.nsfw,
      inEarlyAccess,
      metadata: file.metadata as FileMetadata,
      isDownloadable,
    };
  } catch (error) {
    console.error('[getFileForModelVersion] Error getting download URL:', {
      modelVersionId,
      fileId: file.id,
      fileUrl: file.url,
      filename,
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { status: 'error' };
  }
};

export function getDownloadFilename({
  model,
  modelVersion,
  file,
}: {
  model: { name: string; type: ModelType };
  modelVersion: { name: string; trainedWords?: string[] };
  file: { name: string; overrideName?: string; type: ModelFileType | string };
}) {
  if (file.overrideName) return file.overrideName;

  let fileName = file.name;
  const modelName = filenamize(model.name);
  let versionName = filenamize(replaceInsensitive(modelVersion.name, modelName, ''));

  // If the model name is empty (due to unsupported characters), we should keep the filename as is
  // OR if the type is LORA or LoCon
  const shouldKeepFilename =
    modelName.length === 0 || model.type === ModelType.LORA || model.type === ModelType.LoCon;
  if (shouldKeepFilename) return fileName;

  const ext = file.name.split('.').pop();
  if (!constants.modelFileTypes.includes(file.type as ModelFileType)) return file.name;
  const fileType = file.type as ModelFileType;

  if (fileType === 'Training Data') {
    fileName = `${modelName}_${versionName}_trainingData.zip`;
  } else if (model.type === ModelType.TextualInversion) {
    const trainedWord = modelVersion.trainedWords?.[0];
    let fileSuffix = '';
    if (fileType === 'Negative') fileSuffix = '-neg';

    if (trainedWord) fileName = `${trainedWord}${fileSuffix}.${ext}`;
  } else if (fileType !== 'VAE') {
    let fileSuffix = '';
    if (fileName.toLowerCase().includes('-inpainting')) {
      versionName = versionName.replace(/_?inpainting/i, '');
      fileSuffix = '-inpainting';
    } else if (fileName.toLowerCase().includes('.instruct-pix2pix')) {
      versionName = versionName.replace(/_?instruct|-?pix2pix/gi, '');
      fileSuffix = '.instruct-pix2pix';
    } else if (fileType === 'Text Encoder') fileSuffix = '_txt';

    fileName = `${modelName}_${versionName}${fileSuffix}.${ext}`;
  }
  return fileName;
}

type ModelVersionFileResult =
  | {
      status: 'not-found' | 'unauthorized' | 'archived' | 'downloads-disabled' | 'error';
    }
  | {
      status: 'early-access';
      details: {
        deadline: Date;
      };
    }
  | {
      status: 'success';
      url: string;
      fileId: number;
      modelId: number;
      modelVersionId: number;
      nsfw: boolean;
      inEarlyAccess: boolean;
      metadata: FileMetadata;
      isDownloadable?: boolean;
    };

type FileResult = {
  type: string;
  id: number;
  name: string;
  overrideName?: string;
  metadata: Prisma.JsonValue;
  hashes: {
    hash: string;
  }[];
  url: string;
};
