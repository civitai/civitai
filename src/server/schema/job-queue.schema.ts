import * as z from 'zod';

/**
 * `JobQueue.data` for `ImageStorageDelete`: the storage key, kept because the Image row is gone, and
 * how it goes (see `deleteImageRows` and `queueImageStorageDelete`). `attempted` marks a key whose first delete failed.
 */
export const imageStorageDeletePayloadSchema = z.object({
  url: z.string().min(1),
  allVersions: z.literal(true).optional(),
  keepShopArtwork: z.literal(true).optional(),
  attempted: z.literal(true).optional(),
});
