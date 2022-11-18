import { KeyScope } from '@prisma/client';
import { TypeOf, z } from 'zod';

export const getApiKeyInputSchema = z.object({ key: z.string() });
export type GetAPIKeyInput = TypeOf<typeof getApiKeyInputSchema>;

export const getUserApiKeysInputSchema = z.object({
  skip: z.number().optional(),
  take: z.number().optional(),
});
export type GetUserAPIKeysInput = TypeOf<typeof getUserApiKeysInputSchema>;

export const addApikeyInputSchema = z.object({
  scope: z.array(z.nativeEnum(KeyScope)),
  name: z.string(),
});
export type AddAPIKeyInput = TypeOf<typeof addApikeyInputSchema>;

export const deleteApiKeyInputSchema = z.object({ key: z.string() });
export type DeleteAPIKeyInput = TypeOf<typeof deleteApiKeyInputSchema>;
