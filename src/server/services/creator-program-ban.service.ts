import type { Prisma } from '@prisma/client';
import { refreshSession } from '~/server/auth/session-invalidation';
import { OnboardingSteps } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  handleLogError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

export const CREATOR_PROGRAM_BAN_REASON_MAX = 500;
export const CREATOR_PROGRAM_BAN_GATE_REF_MAX = 200;
const CREATOR_PROGRAM_BAN_ACTIVITY = 'creatorProgramBan';

export type CreatorProgramBanAction = 'set' | 'clear';

type BanClient = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | '$executeRaw'>;

/**
 * Sets or clears `OnboardingSteps.BannedCreatorProgram` on one account, touching no other onboarding
 * bit. Repeating a call changes nothing but is still audited, so the trail shows every decision.
 *
 * The ModActivity row carries the reason (no other column holds it) and is written in the same
 * transaction as the flag: a ban that cannot be audited is not written. Reason and gateRef go last,
 * as JSON, so a `:` in either (a hub card id has several) cannot shift the fields before them.
 */
export async function setCreatorProgramBan(
  {
    userId,
    action,
    reason,
    gateRef,
    moderatorId,
  }: {
    userId: number;
    action: CreatorProgramBanAction;
    reason: string;
    gateRef?: string;
    moderatorId: number;
  },
  client: { $transaction: <T>(fn: (tx: BanClient) => Promise<T>) => Promise<T> } = dbWrite
) {
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw throwBadRequestError('A reason is required.');
  if (trimmedReason.length > CREATOR_PROGRAM_BAN_REASON_MAX)
    throw throwBadRequestError(
      `The reason is longer than ${CREATOR_PROGRAM_BAN_REASON_MAX} characters.`
    );
  if (userId === moderatorId)
    throw throwBadRequestError('You cannot change the Creator Program ban on your own account.');

  const bit = OnboardingSteps.BannedCreatorProgram;
  const result = await client.$transaction(async (tx) => {
    const [row] = await tx.$queryRawUnsafe<{ onboarding: number }[]>(
      `SELECT onboarding FROM "User" WHERE id = $1 FOR NO KEY UPDATE`,
      userId
    );
    if (!row) throw throwNotFoundError(`No user with id ${userId}.`);
    const before = row.onboarding;
    const isSet = (before & bit) !== 0;

    let after = before;
    if (isSet !== (action === 'set')) {
      const [updated] = await tx.$queryRawUnsafe<{ onboarding: number }[]>(
        action === 'set'
          ? `UPDATE "User" SET onboarding = onboarding | $2::int WHERE id = $1 RETURNING onboarding`
          : `UPDATE "User" SET onboarding = onboarding & ~$2::int WHERE id = $1 RETURNING onboarding`,
        userId,
        bit
      );
      after = updated.onboarding;
    }

    await trackModActivity(
      moderatorId,
      {
        entityType: 'user',
        entityId: userId,
        activity: `${CREATOR_PROGRAM_BAN_ACTIVITY}:${action}:${before}:${after}:${JSON.stringify({
          reason: trimmedReason,
          gateRef: gateRef ?? null,
        })}`,
      },
      tx
    );
    return { userId, action, before, after, changed: before !== after };
  });

  // The session shape carries `onboarding`, which is what the Creator Program page reads.
  if (result.changed) await refreshSession(userId, { caller: 'moderation' }).catch(handleLogError);
  return result;
}
