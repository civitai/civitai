import { deletePostRows } from '@civitai/db-queries/content-deletion';
import { kyselyOver } from '~/server/db/prisma-kysely';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { leavePrivateWithHeldVerdict } from '~/server/services/model.service';
import { deleteImages } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { Availability, ModelStatus, ModelUploadType } from '~/shared/utils/prisma/enums';
import { numericString } from '~/utils/zod-helpers';

const schema = z.object({
  id: numericString(),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);

  const model = await dbWrite.model.findUnique({
    where: { id: params.id },
  });

  if (!model || model.uploadType !== ModelUploadType.Trained) {
    res.status(400).json({ error: 'Model is not a training model' });
    return;
  }

  await leavePrivateWithHeldVerdict(params.id, (tx) =>
    tx.model.update({
      where: { id: params.id },
      data: {
        status: ModelStatus.Draft,
        availability: Availability.Public,
        lastVersionAt: null,
      },
    })
  );

  const modelVersions = await dbWrite.modelVersion.findMany({
    where: { modelId: params.id },
  });

  await dbWrite.modelVersion.updateMany({
    where: { id: { in: modelVersions.map((v) => v.id) } },
    data: {
      status: ModelStatus.Draft,
      availability: Availability.Public,
      publishedAt: null,
    },
  });

  const posts = await dbWrite.post.findMany({
    where: { modelVersionId: { in: modelVersions.map((v) => v.id) } },
  });

  // Images first, by id: the post delete only unlinks them.
  const postIds = posts.map((p) => p.id);
  if (postIds.length) {
    const actor = { system: 'reset-training-model' };
    const images = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Image" WHERE "postId" = ANY(${postIds}::int[])
    `;
    await deleteImages(
      images.map((i) => i.id),
      {
        actor,
        updatePosts: false,
        keepStoredFiles: true,
      }
    );
    await deletePostRows(kyselyOver(dbWrite), { ids: postIds, actor });
  }

  res.status(200).json({ finished: true });
});
