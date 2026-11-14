import * as z from 'zod';
import {
  parseResyncUserIds,
  resyncTipaltiPayees,
  TIPALTI_RESYNC_MAX_USERS,
} from '~/server/services/tipalti-payee-resync.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('tipalti.resyncPayee', {
  summary:
    "Re-read users' Tipalti payees and set their payable flag (which gates cash withdrawals) and account status from Tipalti's own record.",
  returns:
    "{ execute, rows: [{ userId, before: { status, paymentsEnabled } | null, tipalti: { status, isPayable, unpayableReasons, lastChangeDateTimeUTC, paymentMethodType } | null, refused, wouldChange, direction: 'enable' | 'disable' | null, applied, error? }] }",
  notes: [
    'Dry run unless `execute=true`. The dry run reads Tipalti and reports what execute would change.',
    'Tipalti is only read (GET /payees). Both directions are applied: a payee Tipalti says is unpayable is disabled.',
    'Per user it refuses to write when: no Tipalti account is on file, Tipalti returns no payee or the read fails, the payee refCode or id does not match ours, isPayable is absent, the status is unrecognised, or the stored row changed during the read.',
    `At most ${TIPALTI_RESYNC_MAX_USERS} ids per call; a malformed or repeated id rejects the call. 5 calls a minute per moderator.`,
    "unpayableReasons is reported, never written, and is not passed on: a disable here sends no tax-form email. Enabling sends the user the usual 'payments enabled' notification.",
    "A write that newly moves an unpayable payee's status to Blocked or BlockedByProvider sends the user the 'creators-program-rejected-tipalti' notification, a status-only change included.",
    'The write is conditional on the stored state read at the start of this call; if a webhook changed it first, nothing is written or sent and the row is refused.',
  ],
  rateLimit: { max: 5, windowSeconds: 60 },
  input: z.object({
    userIds: z.string().transform((raw, ctx) => {
      const parsed = parseResyncUserIds(raw);
      if ('error' in parsed) {
        ctx.addIssue({ code: 'custom', message: parsed.error });
        return z.NEVER;
      }
      return parsed.userIds;
    }),
    execute: moderatorBoolean.default(false),
  }),
  async handler(input, ctx) {
    const rows = await resyncTipaltiPayees({
      userIds: input.userIds,
      dryRun: !input.execute,
      actorId: ctx.actor.id,
    });
    return {
      execute: input.execute,
      rows,
      affected: {
        applied: rows
          .filter((r) => r.applied)
          .map((r) => ({ userId: r.userId, before: r.before, direction: r.direction })),
      },
    };
  },
});
