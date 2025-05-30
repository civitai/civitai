import { KeyScope } from '~/shared/utils/prisma/enums';
import type { TypeOf } from 'zod';
import { z } from 'zod';

export const getApiKeyInputSchema = z.object({ id: z.number() });
export type GetAPIKeyInput = TypeOf<typeof getApiKeyInputSchema>;

export const getUserApiKeysInputSchema = z.object({
  skip: z.number().optional(),
  take: z.number().optional(),
});
export type GetUserAPIKeysInput = TypeOf<typeof getUserApiKeysInputSchema>;

export const addApiKeyInputSchema = z.object({
  scope: z.array(z.nativeEnum(KeyScope)),
  name: z.string(),
});
export type AddAPIKeyInput = z.input<typeof addApiKeyInputSchema>;

export const deleteApiKeyInputSchema = z.object({ id: z.number() });
export type DeleteAPIKeyInput = TypeOf<typeof deleteApiKeyInputSchema>;
