import * as z from 'zod';

/**
 * An AppBlock id (`apb_…`) as the document store keys apps: the store's own app-id shape, so a
 * malformed id is a 400 here rather than a 500 from the store's context check.
 */
const appBlockIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const appStorageForAppSchema = z.strictObject({ appBlockId: appBlockIdSchema });

export const emptyMyAppStorageSchema = z.strictObject({
  appBlockId: appBlockIdSchema,
  /** Also delete the visible shared documents the user authored. Off unless asked for. */
  includeShared: z.boolean().default(false),
});
