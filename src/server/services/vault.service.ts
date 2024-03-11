import { ModelHashType, ModelStatus, Prisma, VaultItemStatus } from '@prisma/client';
import { env } from '~/env/server.mjs';
import { constants } from '~/server/common/constants';
import { VaultSort } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  GetPaginatedVaultItemsSchema,
  VaultItemsAddModelVersionSchema,
  VaultItemsRefreshSchema,
  VaultItemsRemoveModelVersionsSchema,
  VaultItemsUpdateNotesSchema,
} from '~/server/schema/vault.schema';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { getCategoryTags } from '~/server/services/system-cache';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { formatDate } from '~/utils/date-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { deleteManyObjects, getGetUrlByKey, parseKey } from '~/utils/s3-utils';
import { getDisplayName } from '~/utils/string-helpers';

type VaultWithUsedStorage = {
  userId: number;
  storageKb: number;
  meta: MixedObject;
  usedStorageKb: number;
  updatedAt: Date;
};

export const getVaultWithStorage = async ({ userId }: { userId: number }) => {
  const [row] = await dbWrite.$queryRaw<VaultWithUsedStorage[]>`
    SELECT
      v."userId",
      v."storageKb",
      v."meta",
      v."updatedAt",
      COALESCE(SUM(vi."detailsSizeKb" + vi."imagesSizeKb" + vi."modelSizeKb")::int, 0) as "usedStorageKb"
    FROM "Vault" v
    LEFT JOIN "VaultItem" vi ON v."userId" = vi."vaultId"
    WHERE v."userId" = ${userId}
    GROUP BY 
      v."userId",
      v."storageKb",
      v."meta"
  `;

  return row;
};

export const getOrCreateVault = async ({ userId }: { userId: number }) => {
  const vault = await getVaultWithStorage({ userId });

  if (vault) {
    return vault;
  }

  // Create vault if it doesn't exist. Requires membership:
  const user = await dbWrite.user.findFirstOrThrow({
    where: { id: userId },
    select: {
      subscription: { select: { status: true, product: { select: { metadata: true } } } },
    },
  });

  const { subscription } = user;
  const isActiveSubscription = ['active', 'trialing'].includes(subscription?.status ?? 'inactive');

  if (!subscription || !isActiveSubscription)
    throw throwBadRequestError('User does not have an active membership.');

  const tier: string | undefined = (subscription.product.metadata as any)[env.STRIPE_METADATA_KEY];
  type SubscriptionMetadata = {
    vaultSizeKb?: string;
  };
  const { vaultSizeKb: vaultSizeKbString }: SubscriptionMetadata =
    (subscription.product.metadata as SubscriptionMetadata) ?? {};
  const vaultSizeKb = parseInt(vaultSizeKbString ?? '', 10);

  if (!tier) {
    throw throwBadRequestError('User does not have a membership.');
  }

  if (!vaultSizeKb) {
    throw throwBadRequestError(
      'Vault size has not been configured correctly. Please contact administration.'
    );
  }

  // We will need to fetch it after the fact to get with used storage.
  await dbWrite.vault.create({
    data: {
      userId,
      storageKb: vaultSizeKb,
    },
  });

  return getVaultWithStorage({ userId });
};

export const getModelVersionDataForVault = async ({
  modelVersionId,
}: {
  modelVersionId: number;
}) => {
  const modelVersion = await dbRead.modelVersion.findUnique({
    where: { id: modelVersionId },
    include: {
      files: {
        include: {
          hashes: true,
        },
      },
      model: {
        include: {
          tagsOnModels: { select: { tag: { select: { id: true, name: true } } } },
          user: true,
        },
      },
      rank: {
        select: { downloadCountAllTime: true },
      },
    },
  });

  if (!modelVersion) {
    throw throwNotFoundError('Model version not found.');
  }

  if (modelVersion.status !== ModelStatus.Published) {
    throw throwNotFoundError('Model version not published. Cannot store in vault.');
  }

  if (!modelVersion.files.length) {
    throw throwNotFoundError('Model version has no files.');
  }

  const validFiles = modelVersion.files
    .filter(
      (file) => file.hashes.length > 0 && file.hashes.some((h) => h.type === ModelHashType.SHA256)
    )
    .map((file) => ({
      ...file,
      metadata: (file.metadata || {}) as FileMetadata,
    }));

  const mainFile = getPrimaryFile(validFiles);

  if (!mainFile) {
    throw throwNotFoundError('Model version has no primary file.');
  }

  const images = await getImagesForModelVersion({
    modelVersionIds: [modelVersionId],
    imagesPerVersion: 10,
    excludedTagIds: [],
    include: ['tags'],
  });

  const modelVersionSettings = (modelVersion.settings ?? {}) as MixedObject;

  const tableRows = [
    {
      header: 'Type',
      value: `${getDisplayName(modelVersion.model.type)} ${
        modelVersion.model.checkpointType ?? ''
      }`,
    },
    {
      header: 'Stats',
      value: (modelVersion.rank?.downloadCountAllTime ?? 0).toLocaleString(),
      visible: !!modelVersion?.rank,
    },
    {
      header: 'Uploaded',
      value: formatDate(modelVersion.createdAt),
    },
    {
      header: 'Base Model',
      value: `${modelVersion.baseModel} ${
        modelVersion.baseModelType && modelVersion.baseModelType === 'Standard'
          ? ''
          : modelVersion.baseModelType ?? ''
      }`,
    },
    {
      header: 'Training',
      value: `
        ${modelVersion.steps ? `<span>${modelVersion.steps.toLocaleString()} steps</span>` : ''}
        ${modelVersion.epochs ? `<span>${modelVersion.epochs.toLocaleString()} epochs</span>` : ''}
      `,
      visible: !!modelVersion.steps || !!modelVersion.epochs,
    },
    {
      header: 'Usage Tips',
      value: `
      ${
        modelVersion.clipSkip
          ? `<span>Clip Skip: ${modelVersion.clipSkip.toLocaleString()}</span>`
          : ''
      }
      ${
        modelVersionSettings?.strength
          ? `<span>Strength: ${modelVersionSettings.strength}</span>`
          : ''
      } 
      `,
      visible: !!modelVersion.clipSkip || !!modelVersionSettings?.strength,
    },
    {
      header: 'Trigger Words',
      value: modelVersion.trainedWords?.join(', ') ?? '',
      visible: !!modelVersion.trainedWords?.length,
    },
  ].filter((r) => r.visible === undefined || r.visible);

  const detail = `
    <style>
      table {
        width: 100%;
        margin-bottom: 1rem;
      }
      table,
      th,
      td {
        border: 1px solid black;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 5px;
        text-align: left;
      }
    </style>
    <h1>${modelVersion.model.name} - ${modelVersion.name}</h1>
    <hr />
    <h3>Details</h3>
    <table>
      <tbody>
        ${tableRows
          .map(
            (v) => `
          <tr>
            <th>${v.header}</th>
            <td>${v.value}</td>
          </tr>
        `
          )
          .join('')} 
      </tbody> 
    </table>
    <hr />
    <h3>Description</h3>
    ${modelVersion.description ?? modelVersion.model.description ?? '<p>N/A</p>'}
  `;

  return {
    modelVersion,
    mainFile,
    images,
    detail,
  };
};

export const addModelVersionToVault = async ({
  userId,
  modelVersionId,
}: VaultItemsAddModelVersionSchema & {
  userId: number;
}) => {
  // Confirm we don't have it on vault already:
  const existingVaultItem = await dbRead.vaultItem.findFirst({
    where: {
      vaultId: userId,
      modelVersionId: modelVersionId,
    },
  });

  if (existingVaultItem) {
    return existingVaultItem;
  }

  const vault = await getOrCreateVault({ userId });
  const { modelVersion, mainFile, images, detail } = await getModelVersionDataForVault({
    modelVersionId,
  });
  const modelCategories = await getCategoryTags('model');
  const modelCategoriesIds = modelCategories.map((category) => category.id);
  const category = modelVersion.model.tagsOnModels.find((tagOnModel) =>
    modelCategoriesIds.includes(tagOnModel.tag.id)
  );

  const totalKb =
    mainFile.sizeKB + images.reduce((acc, img) => acc + (img.sizeKB ?? 0), 0) + detail.length;

  if (vault.usedStorageKb + totalKb > vault.storageKb) {
    throw throwBadRequestError(
      `Vault storage limit exceeded. You are trying to store ${formatKBytes(
        totalKb
      )} but you have only ${formatKBytes(vault.storageKb - vault.usedStorageKb)} available.`
    );
  }

  const files = [mainFile].map((f) => f.url);

  const vaultItem = await dbWrite.vaultItem.create({
    data: {
      files,
      modelVersionId,
      vaultId: userId,
      modelName: modelVersion.model.name,
      versionName: modelVersion.name,
      modelId: modelVersion.modelId,
      baseModel: modelVersion.baseModel,
      creatorName: modelVersion.model.user?.username ?? '',
      creatorId: modelVersion.model.userId,
      detailsSizeKb: detail.length,
      imagesSizeKb: images.reduce((acc, img) => acc + (img.sizeKB ?? 0), 0),
      modelSizeKb: mainFile.sizeKB,
      type: modelVersion.model.type,
      category: category?.tag.name ?? '',
      createdAt: modelVersion.createdAt,
    },
  });

  return vaultItem;
};

export const removeModelVersionsFromVault = async ({
  userId,
  modelVersionIds,
}: VaultItemsRemoveModelVersionsSchema & {
  userId: number;
}) => {
  await dbWrite.vaultItem.deleteMany({
    where: {
      vaultId: userId,
      modelVersionId: { in: modelVersionIds },
    },
  });

  const keys = modelVersionIds
    .map((modelVersionId) => {
      return [
        constants.vault.keys.details
          .replace(':modelVersionId', modelVersionId.toString())
          .replace(':userId', userId.toString()),
        constants.vault.keys.images
          .replace(':modelVersionId', modelVersionId.toString())
          .replace(':userId', userId.toString()),
        constants.vault.keys.cover
          .replace(':modelVersionId', modelVersionId.toString())
          .replace(':userId', userId.toString()),
      ];
    })
    .flat();
  if (!keys.length) return;

  if (env.S3_VAULT_BUCKET) {
    await deleteManyObjects(env.S3_VAULT_BUCKET, keys);
  }
};

export const updateVaultItemsNotes = async ({
  userId,
  modelVersionIds,
  notes,
}: VaultItemsUpdateNotesSchema & {
  userId: number;
}) => {
  return await dbWrite.vaultItem.updateMany({
    where: {
      vaultId: userId,
      modelVersionId: { in: modelVersionIds },
    },
    data: {
      notes,
    },
  });
};

export const refreshVaultItems = async ({
  userId,
  modelVersionIds,
}: VaultItemsRefreshSchema & {
  userId: number;
}) => {
  return await dbWrite.vaultItem.updateMany({
    where: {
      vaultId: userId,
      modelVersionId: { in: modelVersionIds },
    },
    data: {
      refreshedAt: new Date(),
      status: VaultItemStatus.Pending, // Resets to pending.
    },
  });
};

export const getPaginatedVaultItems = async (
  input: GetPaginatedVaultItemsSchema & { userId?: number }
) => {
  const { limit = DEFAULT_PAGE_SIZE, page } = input || {};
  const { take, skip } = getPagination(limit, page);

  const where: Prisma.VaultItemFindManyArgs['where'] = {
    vaultId: input.userId,
  };
  const orderBy: Prisma.VaultItemFindManyArgs['orderBy'] = {};

  if (input.sort === VaultSort.RecentlyAdded) {
    orderBy.addedAt = 'desc';
  } else if (input.sort === VaultSort.RecentlyCreated) {
    orderBy.createdAt = 'desc';
  } else if (input.sort === VaultSort.BaseModel) {
    orderBy.baseModel = 'asc';
  } else if (input.sort === VaultSort.ModelName) {
    orderBy.modelName = 'asc';
  } else if (input.sort === VaultSort.Category) {
    orderBy.category = 'asc';
  }

  if (input.query) {
    where.OR = [
      {
        modelName: {
          contains: input.query,
          mode: 'insensitive',
        },
      },
      {
        versionName: {
          contains: input.query,
          mode: 'insensitive',
        },
      },
      {
        creatorName: {
          contains: input.query,
          mode: 'insensitive',
        },
      },
    ];
  }

  if (input.types && input.types.length) {
    where.type = { in: input.types };
  }

  if (input.categories && input.categories.length) {
    where.category = { in: input.categories };
  }

  if (input.dateCreatedFrom) {
    where.createdAt = { gte: input.dateCreatedFrom };
  }

  if (input.dateCreatedTo) {
    where.createdAt = { lte: input.dateCreatedTo };
  }

  if (input.dateAddedFrom) {
    where.addedAt = { gte: input.dateAddedFrom };
  }

  if (input.dateAddedTo) {
    where.addedAt = { lte: input.dateAddedTo };
  }

  const items = await dbRead.vaultItem.findMany({
    where,
    take,
    skip,
    orderBy,
  });

  const itemsWithCoverImages = await Promise.all(
    items.map(async (item) => {
      const { url } = await getGetUrlByKey(
        constants.vault.keys.cover
          .replace(':modelVersionId', item.modelVersionId.toString())
          .replace(':userId', item.vaultId.toString()),
        { bucket: env.S3_VAULT_BUCKET }
      );

      return {
        ...item,
        coverImageUrl: url,
      };
    })
  );

  const count = await dbRead.vaultItem.count({ where });

  return getPagingData({ items: itemsWithCoverImages, count: (count as number) ?? 0 }, limit, page);
};

export const isModelVersionInVault = async ({
  userId,
  modelVersionId,
}: VaultItemsAddModelVersionSchema & {
  userId: number;
}) => {
  const exists = await dbRead.vaultItem.findFirst({
    where: {
      vaultId: userId,
      modelVersionId: modelVersionId,
    },
  });

  return !!exists;
};

export const toggleModelVersionOnVault = async ({
  userId,
  modelVersionId,
}: VaultItemsAddModelVersionSchema & {
  userId: number;
}) => {
  const existingVaultItem = await dbRead.vaultItem.findFirst({
    where: {
      vaultId: userId,
      modelVersionId: modelVersionId,
    },
  });

  if (existingVaultItem) {
    return await removeModelVersionsFromVault({ userId, modelVersionIds: [modelVersionId] });
  } else {
    return await addModelVersionToVault({ userId, modelVersionId });
  }
};
