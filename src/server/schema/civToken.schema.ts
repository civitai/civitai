import { z } from 'zod';

export const civTokenEndpoint = '/api/auth/civ-token';
export const impersonateEndpoint = '/api/auth/impersonate';

export const encryptedDataSchema = z.object({
  iv: z.string(),
  data: z.string(),
  signedAt: z.string(),
});
export type EncryptedDataSchema = z.infer<typeof encryptedDataSchema>;
