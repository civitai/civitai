import * as z from 'zod';

/** `JobQueue.data` for `ImageStorageDelete`: the storage key, kept because the Image row is gone. */
export const imageStorageDeletePayloadSchema = z.object({ url: z.string().min(1) });
export type ImageStorageDeletePayload = z.infer<typeof imageStorageDeletePayloadSchema>;
