import { Currency } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { imageGenerationSchema, imageSchema } from '~/server/schema/image.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { baseFileSchema } from './file.schema';

export type BountyEntryFileMeta = z.infer<typeof bountyEntryFileMeta>;

const bountyEntryFileMeta = z
  .object({
    unlockAmount: z.number(),
    currency: z.enum(Currency),
    benefactorsOnly: z.boolean(),
  })
  .partial();

export type UpsertBountyEntryInput = z.infer<typeof upsertBountyEntryInputSchema>;

export const bountyEntryFileSchema = baseFileSchema.extend({
  metadata: bountyEntryFileMeta,
});
export const upsertBountyEntryInputSchema = z.object({
  id: z.number().optional(),
  bountyId: z.number(),
  files: z.array(bountyEntryFileSchema).min(1),
  ownRights: z.boolean().optional(),
  images: z
    .array(imageSchema.extend({ meta: imageGenerationSchema.omit({ comfy: true }).nullish() }))
    .min(1, 'At least one example image must be uploaded'),
  description: getSanitizedStringSchema().nullish(),
});

// Headless/agent (MCP) friendly bounty-entry submission. The full `upsert`
// requires pre-built file descriptors (baseFileSchema + the unlock metadata)
// and a fully-shaped images array, which is impractical to construct without
// the website's upload UI. `submit` accepts minimal, already-uploaded refs and
// the server assembles the required `upsert` shape from them.
//
// The caller must upload the file(s) to storage first and pass the resulting
// `url` + `name` + `sizeKB`. Images are referenced by their uploaded UUID `url`.
export type SubmitBountyEntryInput = z.infer<typeof submitBountyEntryInputSchema>;
export const submitBountyEntryInputSchema = z.object({
  id: z.number().optional(),
  bountyId: z.number(),
  description: getSanitizedStringSchema().nullish(),
  ownRights: z.boolean().optional(),
  // Already-uploaded files. metadata controls buzz-unlock pricing; default is a
  // free (0 buzz), non-benefactor-only entry when unlock fields are omitted.
  files: z
    .array(
      z.object({
        id: z.number().optional(),
        url: z.url().min(1, 'You must provide a file url'),
        name: z.string().min(1),
        sizeKB: z.number(),
        unlockAmount: z.number().optional(),
        currency: z.enum(Currency).optional(),
        benefactorsOnly: z.boolean().optional(),
      })
    )
    .min(1, 'At least one file must be provided'),
  // Already-uploaded example image UUIDs.
  imageUuids: z.array(z.string().uuid()).min(1, 'At least one example image must be provided'),
});
