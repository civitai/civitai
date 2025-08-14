import * as z from 'zod';

export const encryptedDataSchema = z.object({
  iv: z.string(),
  data: z.string(),
  signedAt: z.string(),
});
export type EncryptedDataSchema = z.infer<typeof encryptedDataSchema>;
