import * as z from 'zod';

/**
 * `JobQueue.data` for `ImageStorageDelete`: the storage key, kept because the Image row is gone, and
 * whether every version of it goes.
 */
export const imageStorageDeletePayloadSchema = z.object({
  url: z.string().min(1),
  allVersions: z.literal(true).optional(),
});
export type ImageStorageDeletePayload = z.infer<typeof imageStorageDeletePayloadSchema>;
