import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { userDownloadsCache } from '~/server/redis/caches';
import type { HideDownloadInput } from '~/server/schema/download.schema';
import { imagesForModelVersionsCache } from '~/server/services/image.service';
import { getUserSettings, setUserSetting } from '~/server/services/user.service';
import type { MediaType, ModelType } from '~/shared/utils/prisma/enums';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';

type FileMetadata = {
  format?: ModelFileFormat;
  size?: string;
  fp?: string;
};

export type DownloadHistoryItem = {
  downloadAt: Date;
  modelVersion: {
    id: number;
    name: string;
    baseModel: BaseModel;
    model: {
      id: number;
      name: string;
      type: ModelType;
    };
  };
  file: {
    id: number;
    name: string;
    type: string;
    format: ModelFileFormat | null;
  } | null;
  image: {
    id: number;
    url: string;
    name: string;
    type: MediaType;
    nsfwLevel: number;
    width: number;
    height: number;
    hash: string | null;
    metadata: ImageMetadata | VideoMetadata | null;
  } | null;
};

export const getUserDownloads = async ({
  userId,
}: {
  userId: number;
}): Promise<{ items: DownloadHistoryItem[] }> => {
  // Fetch cached downloads and user settings in parallel
  const [cached, { hideDownloadsSince }] = await Promise.all([
    userDownloadsCache.fetch([userId]),
    getUserSettings(userId),
  ]);

  let downloads = cached[userId]?.downloads ?? [];

  // Filter by hideDownloadsSince if set
  if (hideDownloadsSince) {
    downloads = downloads.filter((d) => d.lastDownloaded > hideDownloadsSince);
  }

  // Sort by lastDownloaded DESC (cache already limits to 2000)
  downloads = downloads.sort((a, b) => b.lastDownloaded - a.lastDownloaded);

  if (downloads.length === 0) {
    return { items: [] };
  }

  // Get unique model version IDs and file IDs
  const downloadedVersionIds = [...new Set(downloads.map((dh) => dh.modelVersionId))];
  const downloadedFileIds = [...new Set(downloads.map((dh) => dh.fileId).filter((id) => id > 0))];

  // Check which of these downloads are hidden
  const hiddenDownloads = await dbRead.$queryRaw<{ modelVersionId: number }[]>`
    SELECT "modelVersionId"
    FROM "HiddenDownload"
    WHERE "userId" = ${userId}
      AND "modelVersionId" IN (${Prisma.join(downloadedVersionIds)})
  `;
  const hiddenIds = new Set(hiddenDownloads.map((h) => h.modelVersionId));

  // Filter out hidden downloads
  const visibleDownloads = downloads.filter((dh) => !hiddenIds.has(dh.modelVersionId));

  if (visibleDownloads.length === 0) {
    return { items: [] };
  }

  // Get model/version data from PostgreSQL
  const modelVersionIds = [...new Set(visibleDownloads.map((dh) => dh.modelVersionId))];
  const fileIds = [...new Set(visibleDownloads.map((dh) => dh.fileId).filter((id) => id > 0))];

  // Fetch model versions with model data
  const modelVersions = await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: {
      id: true,
      name: true,
      baseModel: true,
      model: {
        select: {
          id: true,
          name: true,
          type: true,
        },
      },
      files: {
        select: {
          id: true,
          name: true,
          type: true,
          metadata: true,
        },
      },
    },
  });

  // Fetch specific files if we have fileIds
  const filesMap = new Map<
    number,
    { id: number; name: string; type: string; format: ModelFileFormat | null }
  >();
  for (const mv of modelVersions) {
    for (const file of mv.files) {
      const metadata = file.metadata as FileMetadata | null;
      filesMap.set(file.id, {
        id: file.id,
        name: file.name,
        type: file.type,
        format: metadata?.format ?? null,
      });
    }
  }

  // Create a map for model versions
  const versionMap = new Map(modelVersions.map((mv) => [mv.id, mv]));

  // Fetch images for model versions from cache
  const imageCache = await imagesForModelVersionsCache.fetch(modelVersionIds);

  // Combine the data, filtering out downloads where the model version no longer exists
  const items: DownloadHistoryItem[] = [];

  for (const dh of visibleDownloads) {
    const version = versionMap.get(dh.modelVersionId);

    // Skip downloads where the model version has been deleted
    if (!version) {
      continue;
    }

    // Get file info - handle fileId=0 for historical downloads
    let fileInfo: DownloadHistoryItem['file'] = null;
    if (dh.fileId > 0) {
      const file = filesMap.get(dh.fileId);
      if (file) {
        fileInfo = file;
      }
    } else {
      // For historical downloads (fileId=0), find the primary model file
      const primaryFile = version.files.find((f) => f.type === 'Model') ?? version.files[0];
      if (primaryFile) {
        const metadata = primaryFile.metadata as FileMetadata | null;
        fileInfo = {
          id: primaryFile.id,
          name: primaryFile.name,
          type: primaryFile.type,
          format: metadata?.format ?? null,
        };
      }
    }

    // Get first image for thumbnail
    const versionImages = imageCache[dh.modelVersionId]?.images ?? [];
    const firstImage = versionImages[0];

    items.push({
      downloadAt: new Date(dh.lastDownloaded),
      modelVersion: {
        id: dh.modelVersionId,
        name: version.name,
        baseModel: version.baseModel as BaseModel,
        model: {
          id: version.model.id,
          name: version.model.name,
          type: version.model.type,
        },
      },
      file: fileInfo,
      image: firstImage
        ? {
            id: firstImage.id,
            url: firstImage.url,
            name: firstImage.name,
            type: firstImage.type,
            nsfwLevel: firstImage.nsfwLevel,
            width: firstImage.width,
            height: firstImage.height,
            hash: firstImage.hash,
            metadata: firstImage.metadata,
          }
        : null,
    });
  }

  return { items };
};

export const hideDownload = async ({
  modelVersionId,
  userId,
  all = false,
}: HideDownloadInput & { userId: number }) => {
  if (all) {
    // Hide all downloads using hideDownloadsSince setting
    return setUserSetting(userId, { hideDownloadsSince: Date.now() });
  }

  if (!modelVersionId) {
    throw new Error('modelVersionId is required to hide individual downloads');
  }

  await dbWrite.$executeRaw`
    INSERT INTO "HiddenDownload" ("userId", "modelVersionId", "createdAt")
    VALUES (${userId}, ${modelVersionId}, NOW())
    ON CONFLICT ("userId", "modelVersionId") DO NOTHING
  `;
};
