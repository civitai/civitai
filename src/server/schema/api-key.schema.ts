import { KeyScope } from '~/shared/utils/prisma/enums';
import * as z from 'zod';

export const getApiKeyInputSchema = z.object({ id: z.number() });
export type GetAPIKeyInput = z.infer<typeof getApiKeyInputSchema>;

export const getUserApiKeysInputSchema = z.object({
  skip: z.number().optional(),
  take: z.number().optional(),
});
export type GetUserAPIKeysInput = z.infer<typeof getUserApiKeysInputSchema>;

export const addApiKeyInputSchema = z.object({
  scope: z.array(z.enum(KeyScope)),
  name: z.string(),
});
export type AddAPIKeyInput = z.input<typeof addApiKeyInputSchema>;

export const deleteApiKeyInputSchema = z.object({ id: z.number() });
export type DeleteAPIKeyInput = z.infer<typeof deleteApiKeyInputSchema>;
