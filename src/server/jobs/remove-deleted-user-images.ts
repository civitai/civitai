import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { deleteImages } from '~/server/services/image.service';
import { createJob, getJobDate } from './job';

export const USERS_PER_RUN = 50;
export const DELETE_BATCH_SIZE = 100;
export const DEFAULT_IMAGES_PER_RUN = 500;
export const CURSOR_KEY = 'remove-deleted-user-images-cursor';

/**
 * Wrap sentinel. The drain walks `deletedAt` DESC, so it walks *away* from accounts deleted
 * after the run started; parking the cursor above every possible `deletedAt` on an empty page
 * is what brings those accounts back into range.
 */
export const CURSOR_START = new Date('9999-12-31T23:59:59.999Z');

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
  // A fractional budget reaches Postgres as `LIMIT 1.5`, which errors out every user in the run.
  return Math.floor(parsed);
}

export const removeDeletedUserImages = createJob(
  'remove-deleted-user-images',
  '15 * * * *',
  async (ctx) => {
    const budget = await getImagePurgeBudget();
    if (budget <= 0) return { paused: true, deletedImages: 0, deletedUsers: 0 };

    const [cursor, setCursor] = await getJobDate(CURSOR_KEY, CURSOR_START);

    const users = await dbRead.$queryRaw<{ id: number; deletedAt: Date }[]>`
      SELECT u.id, u."deletedAt"
      FROM "User" u
      WHERE u."deletedAt" IS NOT NULL
        AND u."deletedAt" < ${cursor}
        AND (
          EXISTS (SELECT 1 FROM "Image" i WHERE i."userId" = u.id)
          OR EXISTS (SELECT 1 FROM "Post" p WHERE p."userId" = u.id)
        )
      ORDER BY u."deletedAt" DESC
      LIMIT ${USERS_PER_RUN}
    `;

    if (!users.length) {
      await setCursor(CURSOR_START);
      return { deletedImages: 0, deletedUsers: 0, wrapped: true };
    }

    let remaining = budget;
    let deletedImages = 0;
    let deletedUsers = 0;
    let drainedThrough: Date | undefined;

    for (const user of users) {
      if (remaining <= 0) break;
      ctx.checkIfCanceled();

      try {
        // Joined rather than trusted from the worklist: that was read off a replica, so a
        // restore (or replica lag) between the two would otherwise purge a live account.
        const images = await dbWrite.$queryRaw<{ id: number }[]>`
          SELECT i.id
          FROM "Image" i
          JOIN "User" u ON u.id = i."userId" AND u."deletedAt" IS NOT NULL
          WHERE i."userId" = ${user.id}
          LIMIT ${remaining}
        `;

        for (const batch of chunk(
          images.map((i) => i.id),
          DELETE_BATCH_SIZE
        )) {
          ctx.checkIfCanceled();
          const deleted = await deleteImages(batch);
          deletedImages += deleted.length;
          remaining -= batch.length;
        }

        const [state] = await dbWrite.$queryRaw<{ stillDeleted: boolean; hasImages: boolean }[]>`
          SELECT
            EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${user.id} AND u."deletedAt" IS NOT NULL) AS "stillDeleted",
            EXISTS (SELECT 1 FROM "Image" i WHERE i."userId" = ${user.id}) AS "hasImages"
        `;
        if (!state.stillDeleted || state.hasImages) continue;

        const posts = await dbWrite.$queryRaw<{ id: number }[]>`
          SELECT id FROM "Post" WHERE "userId" = ${user.id}
        `;
        for (const batch of chunk(
          posts.map((p) => p.id),
          DELETE_BATCH_SIZE
        )) {
          ctx.checkIfCanceled();
          await dbWrite.$executeRaw`
            DELETE FROM "Post"
            WHERE id IN (${Prisma.join(batch)})
              AND "userId" = ${user.id}
              AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${user.id} AND u."deletedAt" IS NOT NULL)
          `;
        }

        deletedUsers += 1;
        drainedThrough = user.deletedAt;
      } catch (error) {
        await logToAxiom({
          type: 'error',
          name: 'remove-deleted-user-images',
          message: (error as Error).message,
          error: safeError(error),
          userId: user.id,
        }).catch(() => undefined);
      }
    }

    // Only past users that finished: one left half-drained by the budget must stay in range.
    if (drainedThrough) await setCursor(drainedThrough);

    await logToAxiom({
      type: 'info',
      name: 'remove-deleted-user-images',
      deletedImages,
      deletedUsers,
      candidates: users.length,
      budget,
    }).catch(() => undefined);

    return { deletedImages, deletedUsers };
  },
  { lockExpiration: 30 * 60, dedicated: true }
);
