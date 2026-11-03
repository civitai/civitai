import type { Prisma } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { listImageTagsForImages } from '@civitai/db-queries/hot-reads';
import { imageTagCompositeSelect } from '~/server/selectors/tag.selector';

/**
 * The rows behind `imageTagsCache` (caches.ts), in the shape the Prisma `imageTag.findMany` with this
 * select returned. Taking the client lets services/__tests__/hot-reads-2.kysely-parity.test.ts run
 * the very code the cache runs.
 */
const imageTagsForImagesSelect = {
  imageId: true,
  ...imageTagCompositeSelect,
} satisfies Prisma.ImageTagSelect;

export type ImageTagsForImagesRow = Prisma.ImageTagGetPayload<{
  select: typeof imageTagsForImagesSelect;
}>;

export async function readImageTagsViaKysely(
  db: Kysely<DB>,
  ids: number[]
): Promise<ImageTagsForImagesRow[]> {
  return (await listImageTagsForImages(db, ids)) as ImageTagsForImagesRow[];
}
