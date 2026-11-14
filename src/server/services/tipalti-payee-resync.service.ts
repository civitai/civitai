import * as z from 'zod';
import { TipaltiStatus } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import tipaltiCaller from '~/server/http/tipalti/tipalti.caller';
import { Tipalti } from '~/server/http/tipalti/tipalti.schema';
import { logToAxiom } from '~/server/logging/client';
import { userCashCache } from '~/server/services/creator-program.service';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  TipaltiStaleWriteError,
  updateByTipaltiAccount,
} from '~/server/services/user-payment-configuration.service';

export const TIPALTI_RESYNC_MAX_USERS = 50;

const unpayableReasonsSchema = z.array(z.string().max(200)).max(20);

// Error text stays in Axiom; the response carries only our own wording.
function logResyncError(actorId: number, userId: number, step: string, error: unknown) {
  logToAxiom(
    {
      type: 'error',
      name: 'tipalti-payee-resync',
      details: { actorId, userId, step, message: (error as Error)?.message },
    },
    'webhooks'
  ).catch(() => null);
}

export type TipaltiResyncRow = {
  userId: number;
  before: { status: string | null; paymentsEnabled: boolean } | null;
  tipalti: {
    status: string;
    isPayable: boolean | null;
    unpayableReasons: string[] | null;
    lastChangeDateTimeUTC: string | null;
    paymentMethodType: string | null;
  } | null;
  /** Set when nothing may be written for this user. */
  refused: string | null;
  wouldChange: boolean;
  /** 'enable' (false -> true) or 'disable' (true -> false); null when unchanged or refused. */
  direction: 'enable' | 'disable' | null;
  applied: boolean;
  error?: string;
};

/**
 * Parses `userIds` ("1,2,3"). Refuses rather than skips: a malformed or repeated id is a typo in a
 * money-path request, and silently dropping it would report success for a user nobody looked at.
 */
export function parseResyncUserIds(raw: unknown): { userIds: number[] } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim())
    return { error: 'userIds is required, e.g. ?userIds=1,2' };
  const parts = raw.split(',').map((p) => p.trim());
  const userIds: number[] = [];
  for (const part of parts) {
    if (!/^[1-9]\d*$/.test(part)) return { error: `Invalid user id: "${part}"` };
    const id = Number(part);
    if (!Number.isSafeInteger(id)) return { error: `Invalid user id: "${part}"` };
    if (userIds.includes(id)) return { error: `Duplicate user id: ${id}` };
    userIds.push(id);
  }
  if (userIds.length > TIPALTI_RESYNC_MAX_USERS)
    return {
      error: `At most ${TIPALTI_RESYNC_MAX_USERS} user ids per call (got ${userIds.length})`,
    };
  return { userIds };
}

/**
 * Sets tipaltiPaymentsEnabled (and status) from Tipalti's own payee record. Only GETs Tipalti.
 * The webhook is otherwise the only writer, so a payee whose payability changed without an event
 * stays wrong indefinitely.
 */
export async function resyncTipaltiPayees({
  userIds,
  dryRun,
  actorId,
}: {
  userIds: number[];
  dryRun: boolean;
  actorId: number;
}) {
  const client = await tipaltiCaller();
  const rows: TipaltiResyncRow[] = [];

  // Sequential: a handful of GETs, and it keeps Tipalti's rate limit out of the picture.
  for (const userId of userIds) {
    const row: TipaltiResyncRow = {
      userId,
      before: null,
      tipalti: null,
      refused: null,
      wouldChange: false,
      direction: null,
      applied: false,
    };
    rows.push(row);

    const config = await dbWrite.userPaymentConfiguration.findUnique({ where: { userId } });
    if (!config?.tipaltiAccountId) {
      row.refused = 'No Tipalti account on file';
      continue;
    }
    row.before = {
      status: config.tipaltiAccountStatus,
      paymentsEnabled: config.tipaltiPaymentsEnabled,
    };

    let raw: Record<string, unknown> | null;
    try {
      raw = (await client.getPayeeByRefCode(String(userId))) as Record<string, unknown> | null;
    } catch (error) {
      row.refused = 'Tipalti read failed';
      logResyncError(actorId, userId, 'read', error);
      continue;
    }
    if (!raw) {
      // getPayeeByRefCode also answers null for a failed request (401, 429, 5xx).
      row.refused = 'Tipalti returned no payee, or the read failed';
      continue;
    }

    const parsed = Tipalti.createPayeeResponseSchema.safeParse(raw);
    if (!parsed.success) {
      row.refused = 'Tipalti payee did not match the expected shape';
      continue;
    }
    const payee = parsed.data;

    // Checked before anything about the payee is reported: a mismatch is someone else's record.
    if (payee.refCode !== String(userId)) {
      row.refused = 'Tipalti payee refCode does not match this user';
      continue;
    }
    if (payee.id !== config.tipaltiAccountId) {
      row.refused = 'Tipalti payee id does not match the stored account';
      continue;
    }

    const reasons = unpayableReasonsSchema.safeParse(raw.unpayableReasons);
    row.tipalti = {
      status: payee.status,
      isPayable: typeof payee.isPayable === 'boolean' ? payee.isPayable : null,
      // Reported only, never written or passed on: updateByTipaltiAccount emails the user on a 'tax' reason.
      unpayableReasons: reasons.success ? reasons.data : null,
      lastChangeDateTimeUTC: payee.lastChangeDateTimeUTC ?? null,
      paymentMethodType: payee.paymentMethod?.paymentMethodType ?? null,
    };
    // Absence never becomes false.
    if (typeof payee.isPayable !== 'boolean') {
      row.refused = 'Tipalti payee has no isPayable';
      continue;
    }
    if (payee.status === TipaltiStatus.InternalValue) {
      row.refused = 'Tipalti payee status is not one we recognise';
      continue;
    }

    const statusChanges = payee.status !== config.tipaltiAccountStatus;
    const payableChanges = payee.isPayable !== config.tipaltiPaymentsEnabled;
    row.wouldChange = statusChanges || payableChanges;
    if (payableChanges) row.direction = payee.isPayable ? 'enable' : 'disable';
    if (!row.wouldChange || dryRun) continue;

    try {
      await updateByTipaltiAccount({
        userId,
        // Both are unique: if the user re-onboarded since the read, this matches nothing.
        tipaltiAccountId: config.tipaltiAccountId,
        tipaltiAccountStatus: payee.status,
        tipaltiPaymentsEnabled: payee.isPayable,
        // The Tipalti read can take seconds; a webhook landing meanwhile wins over this snapshot.
        expect: {
          tipaltiAccountStatus: config.tipaltiAccountStatus,
          tipaltiPaymentsEnabled: config.tipaltiPaymentsEnabled,
        },
      });
      row.applied = true;
      await trackModActivity(actorId, {
        entityType: 'user',
        entityId: userId,
        activity: `tipaltiResync:${row.direction ?? 'status'}` as const,
      }).catch((error) => logResyncError(actorId, userId, 'mod-activity', error));
      // withdrawCash reads its ready/pending status from this cache (TTL one day).
      await userCashCache.bust(userId);
    } catch (error) {
      if (error instanceof TipaltiStaleWriteError) {
        row.refused = 'Stored state changed during the Tipalti read; re-run';
        continue;
      }
      row.error = row.applied ? 'Written, but the cash cache bust failed' : 'Write failed';
      logResyncError(actorId, userId, row.applied ? 'cache-bust' : 'write', error);
    }

    if (row.applied) {
      logToAxiom(
        {
          type: 'info',
          name: 'tipalti-payee-resync',
          details: {
            actorId,
            userId,
            before: row.before,
            after: { status: payee.status, paymentsEnabled: payee.isPayable },
            tipalti: row.tipalti,
            error: row.error,
          },
        },
        'webhooks'
      ).catch(() => null);
    }
  }

  logToAxiom(
    {
      type: 'info',
      name: 'tipalti-payee-resync-run',
      details: { actorId, dryRun, rows },
    },
    'webhooks'
  ).catch(() => null);

  return rows;
}
