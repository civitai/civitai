import { ModelHashType, ModelStatus, Prisma, VaultItemStatus } from '@prisma/client';
import { env } from '~/env/server.mjs';
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
import { formatKBytes } from '~/utils/number-helpers';

const getVaultUsedStorage = async ({ userId }: { userId: number }) => {
  const [row] = await dbRead.$queryRaw<{ totalKb: number }[]>`
    SELECT SUM("detailsSizeKb" + "imagesSizeKb" + "modelSizeKb") as "totalKb"
    FROM "VaultItem"
    WHERE "vaultId" = ${userId}
  `;

  return row?.totalKb ?? 0;
};

export const getOrCreateVault = async ({ userId }: { userId: number }) => {
  const vault = await dbWrite.vault.findFirst({
    where: { userId },
  });

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

  const newVault = await dbWrite.vault.create({
    data: {
      userId,
      storageKb: vaultSizeKb,
    },
  });

  return newVault;
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

  const detail = `
    <h1>${modelVersion.model.name} - ${modelVersion.name}</h1>
    <hr />
    ${modelVersion.description}
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
  const vaultUsedStorage = await getVaultUsedStorage({ userId });

  if (vaultUsedStorage + totalKb > vault.storageKb) {
    throw throwBadRequestError(
      `Vault storage limit exceeded. You are trying to store ${formatKBytes(
        totalKb
      )} but you have only ${formatKBytes(vault.storageKb - vaultUsedStorage)} available.`
    );
  }

  const vaultItem = await dbWrite.vaultItem.create({
    data: {
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
      hash: mainFile.hashes.find((h) => h.type === ModelHashType.SHA256)?.hash ?? '',
      type: modelVersion.model.type,
      category: category?.tag.name ?? '',
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
  return await dbWrite.vaultItem.deleteMany({
    where: {
      vaultId: userId,
      modelVersionId: { in: modelVersionIds },
    },
  });
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

  const items = await dbRead.vaultItem.findMany({
    where,
    take,
    skip,
    orderBy: { createdAt: 'desc' },
  });

  const count = await dbRead.vaultItem.count({ where });

  return getPagingData({ items, count: (count as number) ?? 0 }, limit, page);
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
