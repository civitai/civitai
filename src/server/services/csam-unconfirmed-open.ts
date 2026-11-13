import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { csamSendClaimCutoff } from '~/server/services/csam-send-claim';
import { trackModActivity } from '~/server/services/moderator.service';

/**
 * An open NCMEC answered that the client could not read: a CyberTip may be open there with no id
 * here. The report sends nothing more until a moderator who has checked with NCMEC clears it.
 */
export type UnconfirmedOpen = { at: string; message: string };
export type ClearedUnconfirmedOpen = UnconfirmedOpen & {
  clearedAt: string;
  clearedById: number;
  note: string;
};

// The errors the client's response parser throws for a 2xx answer it cannot read. A refusal (non-2xx)
// and a request that never reached NCMEC throw others.
const UNREADABLE_ANSWER = /^(XML response |XML "|Response missing required |Response ")/;

export const isUnreadableAnswer = (e: unknown) =>
  e instanceof Error && UNREADABLE_ANSWER.test(e.message);

export const clearUnconfirmedOpenActivity = 'csamReport:clearUnconfirmedOpen' as const;

/**
 * Lets an unsent report held on an unconfirmed open be sent again, recording who cleared it and why.
 * Refused while a send run holds the report. A run whose claim has expired loses it here, so nothing
 * it writes later can put back what this clears.
 */
export async function clearUnconfirmedOpens(input: {
  reportId: number;
  moderatorId: number;
  note: string;
}) {
  return dbWrite.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<
      {
        details: Record<string, unknown> | null;
        sendClaimId: string | null;
        sendClaimedAt: Date | null;
      }[]
    >`
      SELECT details, "sendClaimId", "sendClaimedAt" FROM "CsamReport"
      WHERE id = ${input.reportId} AND "reportSentAt" IS NULL
      FOR UPDATE
    `;
    const details = row?.details ?? {};
    const held = (details.unconfirmedOpens ?? []) as UnconfirmedOpen[];
    if (!row || !held.length)
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'This report is not held on an unconfirmed CyberTip.',
      });
    if (row.sendClaimId && row.sendClaimedAt && row.sendClaimedAt >= csamSendClaimCutoff())
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A send run holds this report. Try again once it finishes.',
      });
    const clearedAt = new Date().toISOString();
    const cleared: ClearedUnconfirmedOpen[] = held.map((open) => ({
      ...open,
      clearedAt,
      clearedById: input.moderatorId,
      note: input.note,
    }));
    const { unconfirmedOpens: _held, ...rest } = details;
    await tx.csamReport.update({
      where: { id: input.reportId },
      data: {
        sendClaimId: null,
        sendClaimedAt: null,
        details: {
          ...rest,
          clearedUnconfirmedOpens: [
            ...((details.clearedUnconfirmedOpens ?? []) as ClearedUnconfirmedOpen[]),
            ...cleared,
          ],
        },
      },
    });
    await trackModActivity(
      input.moderatorId,
      {
        entityType: 'csamReport',
        entityId: input.reportId,
        activity: clearUnconfirmedOpenActivity,
      },
      tx
    );
    return { cleared: cleared.length };
  });
}
