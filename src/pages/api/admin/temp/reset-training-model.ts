import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
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

  await dbWrite.model.update({
    where: { id: params.id },
    data: {
      status: ModelStatus.Draft,
      availability: Availability.Public,
      lastVersionAt: null,
    },
  });

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

  await dbWrite.post.deleteMany({
    where: { id: { in: posts.map((p) => p.id) } },
  });

  await dbWrite.image.deleteMany({
    where: { postId: { in: posts.map((p) => p.id) } },
  });

  res.status(200).json({ finished: true });
});
