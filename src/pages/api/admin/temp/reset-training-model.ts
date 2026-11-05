import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { detachHeldThreadsCte } from '~/server/services/comment-thread-hold';
import { accountHoldSql } from '~/server/services/legal-hold.service';
import { invalidateManyImageExistence } from '~/server/services/image.service';
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

  // Images first, by id: the post delete only unlinks them. A held owner's rows are left, and the
  // comment threads of the rows that go are detached when they hold a held author's comment.
  const postIds = posts.map((p) => p.id);
  if (postIds.length)
    await dbWrite.$transaction([
      dbWrite.$executeRaw`
        WITH doomed AS (
          SELECT i.id FROM "Image" i
          WHERE i."postId" = ANY(${postIds}::int[])
            AND NOT ${accountHoldSql(Prisma.raw('i."userId"'), true)}
        ),
        ${detachHeldThreadsCte({ imageId: Prisma.sql`SELECT id FROM doomed` }, true)}
        DELETE FROM "Image" WHERE id IN (SELECT id FROM doomed)
      `,
      dbWrite.$executeRaw`
        WITH doomed AS (
          SELECT p.id FROM "Post" p
          WHERE p.id = ANY(${postIds}::int[])
            AND NOT ${accountHoldSql(Prisma.raw('p."userId"'), true)}
        ),
        ${detachHeldThreadsCte({ postId: Prisma.sql`SELECT id FROM doomed` }, true)}
        DELETE FROM "Post" WHERE id IN (SELECT id FROM doomed)
      `,
    ]);

  res.status(200).json({ finished: true });
});
