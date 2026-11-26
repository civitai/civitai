import * as z from 'zod';

/**
 * Inputs of `appPlatformUpdates.*` (staff platform updates). The owner-facing three are the
 * contract the CLI and the App Assistant runner are written against: change them only together
 * with those clients.
 */

const appRef = {
  appBlockId: z.string().min(1).max(64).optional(),
  slug: z.string().min(1).max(64).optional(),
};
const oneOfAppRef = (v: { appBlockId?: string; slug?: string }) => !!v.appBlockId || !!v.slug;
const APP_REF_MESSAGE = { message: 'one of appBlockId or slug is required' };

export const platformUpdateAppSchema = z.object(appRef).refine(oneOfAppRef, APP_REF_MESSAGE);

export const verifyPlatformUpdateCommitSchema = z
  .object({ ...appRef, commitSha: z.string().min(1).max(64) })
  .refine(oneOfAppRef, APP_REF_MESSAGE);

const updateId = z.string().regex(/^apu_[0-9A-HJKMNP-TV-Z]{26}$/, 'not a platform update id');

export const resolvePlatformUpdateSchema = z.object({
  id: updateId,
  outcome: z.enum(['merged', 'conflicted']),
  /** Required when `outcome` is `merged`: the merge commit on the owner's `main`. */
  mergeCommitSha: z.string().min(1).max(64).optional(),
});

export const supersedePlatformUpdateSchema = z.object({ id: updateId });

const changePath = z.string().min(1).max(400);

export const pushPlatformUpdateSchema = z
  .object({
    ...appRef,
    /** Why, in the moderator's words; shown to the owner. Required. */
    reason: z.string().max(4000),
    changes: z
      .array(
        z.discriminatedUnion('operation', [
          z.object({
            operation: z.literal('put'),
            path: changePath,
            content: z.string(),
            encoding: z.enum(['utf8', 'base64']).default('utf8'),
          }),
          z.object({ operation: z.literal('delete'), path: changePath }),
        ])
      )
      .min(1)
      .max(100),
  })
  .refine(oneOfAppRef, APP_REF_MESSAGE);

export type PushPlatformUpdateInput = z.infer<typeof pushPlatformUpdateSchema>;
