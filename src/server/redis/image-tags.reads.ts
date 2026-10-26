import type { Prisma, PrismaClient } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { listImageTagsForImages } from '@civitai/db-queries/hot-reads';
import { imageTagCompositeSelect } from '~/server/selectors/tag.selector';

/**
 * The rows behind `imageTagsCache` (caches.ts): one Prisma reader and its Kysely twin, both taking
 * the client, so the parity suite (services/__tests__/hot-reads-2.kysely-parity.test.ts) runs the
 * very code the cache runs.
 */
const imageTagsForImagesSelect = {
  imageId: true,
  ...imageTagCompositeSelect,
} satisfies Prisma.ImageTagSelect;

export type ImageTagsForImagesRow = Prisma.ImageTagGetPayload<{
  select: typeof imageTagsForImagesSelect;
}>;

export function readImageTagsViaPrisma(
  db: PrismaClient,
  ids: number[]
): Promise<ImageTagsForImagesRow[]> {
  return db.imageTag.findMany({
    where: { imageId: { in: ids } },
    select: imageTagsForImagesSelect,
    orderBy: [{ score: 'desc' }, { tagId: 'asc' }],
  });
}

export async function readImageTagsViaKysely(
  db: Kysely<DB>,
  ids: number[]
): Promise<ImageTagsForImagesRow[]> {
  return (await listImageTagsForImages(db, ids)) as ImageTagsForImagesRow[];
}
