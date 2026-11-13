import { TipaltiStatus } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import tipaltiCaller from '~/server/http/tipalti/tipalti.caller';
import { Tipalti } from '~/server/http/tipalti/tipalti.schema';
import { logToAxiom } from '~/server/logging/client';
import { userCashCache } from '~/server/services/creator-program.service';
import { updateByTipaltiAccount } from '~/server/services/user-payment-configuration.service';

export const TIPALTI_RESYNC_MAX_USERS = 50;

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
    unpayableReasons: unknown;
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
      row.refused = 'Tipalti returned no payee for this refCode';
      continue;
    }

    const parsed = Tipalti.createPayeeResponseSchema.safeParse(raw);
    if (!parsed.success) {
      row.refused = 'Tipalti payee did not match the expected shape';
      continue;
    }
    const payee = parsed.data;
    row.tipalti = {
      status: payee.status,
      isPayable: typeof payee.isPayable === 'boolean' ? payee.isPayable : null,
      // Reported only, never written: it is why a payee is unpayable.
      unpayableReasons: raw.unpayableReasons ?? null,
      lastChangeDateTimeUTC: payee.lastChangeDateTimeUTC ?? null,
      paymentMethodType: payee.paymentMethod?.paymentMethodType ?? null,
    };

    if (payee.refCode !== String(userId)) {
      row.refused = `Tipalti refCode ${payee.refCode ?? '(none)'} does not match user ${userId}`;
      continue;
    }
    if (payee.id !== config.tipaltiAccountId) {
      row.refused = `Tipalti payee id ${payee.id} does not match stored ${config.tipaltiAccountId}`;
      continue;
    }
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

    let updated;
    try {
      updated = await updateByTipaltiAccount({
        userId,
        tipaltiAccountStatus: payee.status,
        tipaltiPaymentsEnabled: payee.isPayable,
      });
      row.applied = true;
      // withdrawCash reads its ready/pending status from this cache (TTL one day).
      await userCashCache.bust(userId);
    } catch (error) {
      row.error = row.applied ? 'Written, but the cash cache bust failed' : 'Write failed';
      logResyncError(actorId, userId, row.applied ? 'cache-bust' : 'write', error);
      continue;
    }

    logToAxiom(
      {
        type: 'info',
        name: 'tipalti-payee-resync',
        details: {
          actorId,
          userId,
          before: row.before,
          after: {
            status: updated.tipaltiAccountStatus,
            paymentsEnabled: updated.tipaltiPaymentsEnabled,
          },
          tipalti: row.tipalti,
        },
      },
      'webhooks'
    ).catch(() => null);
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
