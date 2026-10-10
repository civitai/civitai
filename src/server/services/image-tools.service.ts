import type { SessionUser } from '~/types/session';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import type {
  AddOrRemoveImageToolsOutput,
  UpdateImageToolsOutput,
  AddOrRemoveImageTechniquesOutput,
  UpdateImageTechniqueOutput,
} from '~/server/schema/image.schema';
import { BlockedReason, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import {
  enqueueImageIngestion,
  purgeImageGenerationDataCache,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';

async function authorizeImagesAction({
  imageIds,
  user,
}: {
  imageIds: number[];
  user: SessionUser;
}) {
  if (!user.isModerator) {
    const images = await dbRead.image.findMany({
      where: { id: { in: imageIds }, userId: user.id },
      select: { id: true },
    });
    const validatedIds = images.map((x) => x.id);
    if (!imageIds.every((id) => validatedIds.includes(id))) throw throwAuthorizationError();
  }
}

export async function addImageTools({
  data,
  user,
}: {
  data: AddOrRemoveImageToolsOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  await dbWrite.imageTool.createMany({ data, skipDuplicates: true });
  // Update these images if blocked:
  const updated = await dbWrite.image.updateManyAndReturn({
    where: { id: { in: data.map((x) => x.imageId) }, blockedFor: BlockedReason.AiNotVerified },
    data: {
      blockedFor: null,
      // Ensures we do another run:
      ingestion: 'Pending',
    },
    select: {
      id: true,
      url: true,
      type: true,
    },
  });

  enqueueImageIngestion({
    images: updated,
    name: 'add-image-tools',
    userId: user.id,
    lowPriority: true,
  });

  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }

  await queueImageSearchIndexUpdate({
    ids: data.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
}

export async function removeImageTools({
  data,
  user,
}: {
  data: AddOrRemoveImageToolsOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  const toolsByImage = data.reduce<Record<number, number[]>>((acc, { imageId, toolId }) => {
    if (!acc[imageId]) acc[imageId] = [];
    acc[imageId].push(toolId);
    return acc;
  }, {});

  await dbWrite.$transaction(
    Object.entries(toolsByImage).map(([imageId, toolIds]) =>
      dbWrite.imageTool.deleteMany({ where: { imageId: Number(imageId), toolId: { in: toolIds } } })
    )
  );
  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }

  await queueImageSearchIndexUpdate({
    ids: data.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
}

export async function updateImageTools({
  data,
  user,
}: {
  data: UpdateImageToolsOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  await dbWrite.$transaction(
    data.map(({ imageId, toolId, notes }) =>
      dbWrite.imageTool.update({
        where: { imageId_toolId: { imageId, toolId } },
        data: { notes },
        select: { imageId: true },
      })
    )
  );
  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }
}

export async function addImageTechniques({
  data,
  user,
}: {
  data: AddOrRemoveImageTechniquesOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  await dbWrite.imageTechnique.createMany({ data, skipDuplicates: true });
  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }

  await queueImageSearchIndexUpdate({
    ids: data.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
}

export async function removeImageTechniques({
  data,
  user,
}: {
  data: AddOrRemoveImageTechniquesOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  const techniquesByImage = data.reduce<Record<number, number[]>>(
    (acc, { imageId, techniqueId }) => {
      if (!acc[imageId]) acc[imageId] = [];
      acc[imageId].push(techniqueId);
      return acc;
    },
    {}
  );

  await dbWrite.$transaction(
    Object.entries(techniquesByImage).map(([imageId, techniqueIds]) =>
      dbWrite.imageTechnique.deleteMany({
        where: { imageId: Number(imageId), techniqueId: { in: techniqueIds } },
      })
    )
  );

  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }

  await queueImageSearchIndexUpdate({
    ids: data.map((x) => x.imageId),
    action: SearchIndexUpdateQueueAction.Update,
  });
}

export async function updateImageTechniques({
  data,
  user,
}: {
  data: UpdateImageTechniqueOutput['data'];
  user: SessionUser;
}) {
  await authorizeImagesAction({ imageIds: data.map((x) => x.imageId), user });
  await dbWrite.$transaction(
    data.map(({ imageId, techniqueId, notes }) =>
      dbWrite.imageTechnique.update({
        where: { imageId_techniqueId: { imageId, techniqueId } },
        data: { notes },
        select: { imageId: true },
      })
    )
  );
  for (const { imageId } of data) {
    purgeImageGenerationDataCache(imageId);
  }
}
