import * as z from 'zod';
import { moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';

// Create and update share the whole cosmetic shape —
// update takes it partial — so it is declared once here.
export const cosmeticId = z.coerce.number().int().positive();
export const userIds = z.array(z.coerce.number().int().positive()).min(1).max(5000);

export const cosmeticShape = z.object({
  name: z.string().min(1).max(255).describe('Display name.'),
  description: z.string().nullish().describe('Shown on the cosmetic itself.'),
  videoUrl: z.string().url().nullish().describe('Optional animated preview.'),
  type: z.nativeEnum(CosmeticType).describe('Badge, frame, nameplate, and so on.'),
  source: z.nativeEnum(CosmeticSource).describe('How it is obtained.'),
  permanentUnlock: moderatorBoolean.describe('Once granted, it is never removed by expiry.'),
  data: z.record(z.string(), z.unknown()).describe('Type-specific payload (image urls, colours).'),
  availableStart: z.coerce.date().nullish().describe('Obtainable from this date.'),
  availableEnd: z.coerce.date().nullish().describe('Obtainable until this date.'),
  availableQuery: z.string().nullish().describe('SQL predicate deciding who may obtain it.'),
  productId: z.string().nullish().describe('Linked store product, when purchasable.'),
  leaderboardId: z.string().nullish().describe('Leaderboard that awards it.'),
  leaderboardPosition: z.coerce.number().int().nullish().describe('Position required to earn it.'),
});
