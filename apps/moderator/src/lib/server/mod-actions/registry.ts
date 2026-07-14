import type { z } from 'zod';
import { MOD_ACTION, imageModerateInput } from '@civitai/moderation';
import { acceptImage, blockImage } from '../image-moderation.service';

// The cross-app moderator-action registry. Each entry maps an action the main app invokes over
// `/api/mod/[action]` to a spoke handler. The input SCHEMA is the shared `@civitai/moderation` contract
// (so the endpoint validates the exact shape the main-app client sends); the HANDLER calls the same spoke
// services the moderator pages use, so both entry points run identical code. `userId` is the moderator id,
// asserted by the trusted caller (the main app already gated the action behind `moderatorProcedure`).
//
// This is the ONE sanctioned inbound seam. Add an action here + its schema/method in @civitai/moderation;
// don't add ad-hoc endpoints.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModAction<T = any> = {
  schema: z.ZodType<T>;
  handler: (input: T) => Promise<unknown>;
};

// Backs the main app's `image.moderate` (block/unblock over one or more ids). Single-image verdicts loop
// the spoke services; the moderator UI always sends one id, but the batch shape is preserved.
const imageModerate: ModAction<z.infer<typeof imageModerateInput>> = {
  schema: imageModerateInput,
  handler: async ({ ids, reviewAction, userId, ip, userAgent }) => {
    for (const imageId of ids) {
      // Delegated accept uses the smart default (removeMinorFlag is a spoke-only, minor-page option).
      if (reviewAction === 'unblock') await acceptImage({ imageId, userId });
      else await blockImage({ imageId, userId, ip, userAgent });
    }
    return { count: ids.length };
  },
};

export const modActions: Record<string, ModAction> = {
  [MOD_ACTION.imageModerate]: imageModerate,
};
