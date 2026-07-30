import { chunk } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { deleteImages } from '~/server/services/image.service';
import { createJob } from './job';

export const USERS_PER_RUN = 50;
export const DELETE_BATCH_SIZE = 100;
export const DEFAULT_IMAGES_PER_RUN = 25000;

/**
 * sysRedis.get is typed `string | null`, but the HA/Sentinel client can return
 * a Buffer at runtime — coerce explicitly so the type stays honest and this
 * stays safe if the parsing below ever grows string-sensitive (`.split`, `===`).
 */
export async function getImagePurgeBudget(): Promise<number> {
  const raw = await sysRedis.get(REDIS_SYS_KEYS.SYSTEM.DELETED_USER_IMAGE_PURGE_LIMIT);
  if (raw == null) return DEFAULT_IMAGES_PER_RUN;
  const parsed = Number(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IMAGES_PER_RUN;
  return parsed;
}

export const removeDeletedUserImages = createJob(
  'remove-deleted-user-images',
  '15 * * * *',
  async (ctx) => {
    const budget = await getImagePurgeBudget();
    if (budget <= 0) return { paused: true, deletedImages: 0, deletedUsers: 0 };

    let remaining = budget;
    let deletedImages = 0;
    let deletedUsers = 0;

    const users = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT u.id
      FROM "User" u
      WHERE u."deletedAt" IS NOT NULL
        AND EXISTS (SELECT 1 FROM "Image" i WHERE i."userId" = u.id)
      ORDER BY u."deletedAt" DESC
      LIMIT ${USERS_PER_RUN}
    `;

    for (const user of users) {
      if (remaining <= 0) break;
      ctx.checkIfCanceled();

      try {
        const budgetForUser = remaining;
        const images = await dbRead.$queryRaw<{ id: number }[]>`
          SELECT id FROM "Image" WHERE "userId" = ${user.id} LIMIT ${budgetForUser}
        `;
        if (!images.length) continue;

        for (const batch of chunk(
          images.map((i) => i.id),
          DELETE_BATCH_SIZE
        )) {
          const deleted = await deleteImages(batch);
          deletedImages += deleted.length;
          remaining -= batch.length;
        }

        if (images.length < budgetForUser) {
          await dbWrite.$executeRaw`DELETE FROM "Post" WHERE "userId" = ${user.id}`;
          deletedUsers += 1;
        }
      } catch (error) {
        logToAxiom({
          type: 'error',
          name: 'remove-deleted-user-images',
          message: (error as Error).message,
          userId: user.id,
        });
      }
    }

    console.log(`remove-deleted-user-images: ${deletedImages} images, ${deletedUsers} users`);

    return { deletedImages, deletedUsers };
  },
  { lockExpiration: 30 * 60, dedicated: true }
);
