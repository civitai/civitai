import type { z } from 'zod';
import { MOD_ACTION, abuseReportInput, imageModerateInput } from '@civitai/moderation';
import { acceptImage, blockImage } from '../image-moderation.service';
import { recordAbuseRun } from '../abuse-detection.service';

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

/**
 * Backs an automated detector reporting one run. Unlike every other entry here there is NO acting
 * moderator: the caller is a scheduled job holding the shared token, and `WebhookEndpoint` never
 * populates `locals.user`, so there is no identity to assert and none is asked for. The `userId` on
 * each finding is the account the finding is ABOUT.
 *
 * Write-only from the producer's side — this stores the report and grants nothing. Nothing here
 * excludes, mutes or bans; acting stays with the detector that already owns that credential, which
 * is what keeps a compromised reporting path from becoming a moderation path.
 */
const abuseReport: ModAction<z.infer<typeof abuseReportInput>> = {
  schema: abuseReportInput,
  handler: async (input) => {
    const { runId } = await recordAbuseRun(input);
    return { runId, findings: input.findings.length };
  },
};

export const modActions: Record<string, ModAction> = {
  [MOD_ACTION.imageModerate]: imageModerate,
  [MOD_ACTION.abuseReport]: abuseReport,
};
