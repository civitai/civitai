import { z } from 'zod';
import { CATALOG_MAX, COSMETIC_TYPES, type CatalogQuery } from './item-definitions.service';

const flag = z.string().optional().transform((value) => value === '1');
const shelf = z.coerce.number().int().min(0).max(2_147_483_647).nullable().catch(null);

/** `/catalog` query params, every one degrading to "no filter" rather than failing the request. */
export const catalogQuerySchema = z.object({
  q: z.string().trim().max(100).catch(''),
  event: z.string().trim().max(100).catch(''),
  noEvent: flag.catch(false),
  types: z
    .string()
    .transform((value) => value.split(',').filter((type) => COSMETIC_TYPES.includes(type)))
    .catch([]),
  team: z.string().trim().max(100).catch(''),
  minShelf: shelf,
  maxShelf: shelf,
  noShelf: flag.catch(false),
  needsDefinition: flag.catch(false),
  limit: z.coerce.number().int().min(1).max(CATALOG_MAX).catch(48),
}) satisfies z.ZodType<CatalogQuery, unknown>;
