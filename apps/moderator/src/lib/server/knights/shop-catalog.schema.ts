import { z } from 'zod';
import { NewOrderRankType } from '@civitai/db-schema/enums';
import { MEMBERSHIP_DAYS, SHOP_TIERS } from '@civitai/shared/knights-shop';
import { checkboxField, int4Id } from '../query';
import { MAX_INT4 } from '../users.service';

export const SHOP_KINDS = ['buzz_pack', 'cosmetic', 'membership'] as const;
export const SHOP_RANKS = Object.values(NewOrderRankType);

const positiveInt = (message: string) =>
  z.coerce.number({ error: message }).int(message).positive(message).max(MAX_INT4, message);

/** Fields shared by every kind. Keep in step with EDITABLE in shop-catalog.service.ts: an edit can change only these. */
const settings = {
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'The name is too long.'),
  description: z.string().trim().max(500, 'The description is too long.').default(''),
  price: positiveInt('The price must be a whole number of gold above zero.'),
  minRank: z.preprocess(
    (value) => (value === '' || value == null ? null : value),
    z.enum(SHOP_RANKS, { error: 'Pick a rank from the list.' }).nullable()
  ),
  rotating: checkboxField,
  sortOrder: z.coerce
    .number({ error: 'The sort order must be a number.' })
    .int()
    .min(-100_000)
    .max(100_000),
};

/** Mirrors KnightsShopItem_kind_check: a column that does not apply to the kind stays NULL. */
export const newShopItemSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({
      kind: z.literal('buzz_pack'),
      ...settings,
      buzz: positiveInt('Buzz must be a whole number above zero.'),
    }),
    z.object({
      kind: z.literal('cosmetic'),
      ...settings,
      cosmeticId: int4Id.refine(Boolean, 'Pick a cosmetic from the search.'),
    }),
    z.object({
      kind: z.literal('membership'),
      ...settings,
      tier: z.enum(SHOP_TIERS, { error: 'Pick bronze, silver or gold.' }),
      days: positiveInt('Days must be a whole number above zero.').refine(
        (days) => days === MEMBERSHIP_DAYS,
        'Memberships are sold one week at a time.'
      ),
    }),
  ],
  { error: 'Pick what the item is.' }
);
export type NewShopItem = z.infer<typeof newShopItemSchema>;

export const editShopItemSchema = z.object({ id: int4Id, ...settings });
export type EditShopItem = z.infer<typeof editShopItemSchema>;

export const itemIdSchema = z.object({ id: int4Id });

export type FieldChange = { from: unknown; to: unknown };

export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[]
): Record<string, FieldChange> {
  const changed: Record<string, FieldChange> = {};
  for (const key of keys) {
    if (before[key] !== after[key])
      changed[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return changed;
}
