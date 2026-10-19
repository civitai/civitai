import { z } from 'zod';
import {
  ITEM_DEFINITION_STATUS,
  ITEM_TYPE,
  MOD_GRANT_SOURCE_PREFIX,
  modGrantSourceKey,
} from '@civitai/shared/mystery-box';
import { MAX_BOXES_PER_USER, MAX_GRANT_USERS } from '$lib/mystery-box';
import { dbRead, dbWrite } from './db';
import { escapeLike } from './like';
import { isItemHolderBusy, lockItemHolder } from './item-holder-lock';
import { recordModActivity } from './mod-activity';

/** The form fields every box-grant action takes besides who receives it. */
export const boxGrantFields = {
  count: z.coerce.number().int().min(1).max(MAX_BOXES_PER_USER),
  grantId: z.string().trim().min(1).max(64),
};

/** A grant refused before anything was written. */
export class BoxGrantRefused extends Error {}

export type BoxGrantResult = {
  /** Users who got `count` new boxes. */
  grantedUserIds: number[];
  /** Users this grant id had already given boxes to, held or opened: a resubmitted form. */
  alreadyGrantedUserIds: number[];
  /** Skipped: a purchase, box opening or moderator change held their lock. Granting again is safe. */
  busyUserIds: number[];
  /** Nothing written for them: their grant failed for another reason. Granting again is safe. */
  failedUserIds: number[];
};

/**
 * Gives each user `count` held boxes of a published box, as `Item` rows keyed by `modGrantSourceKey`.
 * No purchase, claim or Buzz is involved, and none may be: the main app reads any purchase of a box
 * as its having gone on sale.
 *
 * `grantId` is minted when the form renders. A user this grant id already reached gets nothing more,
 * whatever `count` is now and whether or not they opened what it gave, so a resubmitted form never
 * grants twice; granting again to the users it skipped finishes the job. One transaction per user under
 * their item-holder lock, as the main app's purchases and opens take it; a failure for one user is
 * reported, not thrown, since the users before them already have their boxes.
 */
export async function grantMysteryBoxes({
  boxId,
  userIds,
  count,
  grantId,
  moderatorId,
}: {
  boxId: number;
  userIds: number[];
  count: number;
  grantId: string;
  moderatorId: number;
}): Promise<BoxGrantResult> {
  const uniqueUserIds = [...new Set(userIds)];
  if (!uniqueUserIds.length) throw new BoxGrantRefused('Name at least one user.');
  if (uniqueUserIds.length > MAX_GRANT_USERS)
    throw new BoxGrantRefused(`Grant to at most ${MAX_GRANT_USERS} users at a time.`);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BOXES_PER_USER)
    throw new BoxGrantRefused(`Grant between 1 and ${MAX_BOXES_PER_USER} boxes each.`);
  const keysFor = (userId: number) =>
    Array.from({ length: count }, (_, i) => modGrantSourceKey(grantId, userId, i + 1));
  try {
    keysFor(uniqueUserIds[0]);
  } catch (e) {
    throw new BoxGrantRefused(e instanceof Error ? e.message : 'Unreadable grant.');
  }

  const box = await dbRead
    .selectFrom('ItemDefinition')
    .select(['id', 'type', 'status'])
    .where('id', '=', boxId)
    .executeTakeFirst();
  if (!box || box.type !== ITEM_TYPE.box) throw new BoxGrantRefused('No such box.');
  if (box.status !== ITEM_DEFINITION_STATUS.published)
    throw new BoxGrantRefused('Only a published box can be granted.');

  const users = await dbRead
    .selectFrom('User')
    .select('id')
    .where('id', 'in', uniqueUserIds)
    .execute();
  const missing = uniqueUserIds.filter((id) => !users.some((u) => u.id === id));
  if (missing.length) throw new BoxGrantRefused(`These users don't exist: ${missing.join(', ')}`);

  const result: BoxGrantResult = {
    grantedUserIds: [],
    alreadyGrantedUserIds: [],
    busyUserIds: [],
    failedUserIds: [],
  };
  for (const userId of uniqueUserIds) {
    // Every key this grant id has ever given this user, whatever the count was.
    const given = `${escapeLike(`${MOD_GRANT_SOURCE_PREFIX}${grantId}-${userId}-`)}%`;
    let outcome: 'granted' | 'already';
    try {
      outcome = await dbWrite.transaction().execute(async (trx) => {
        await lockItemHolder(trx, userId);
        // An opened box's Item is gone and its key lives on in its BoxOpening, so both are asked.
        const held = await trx
          .selectFrom('Item')
          .select('id')
          .where('sourceKey', 'like', given)
          .where('holderType', '=', 'user')
          .where('holderId', '=', userId)
          .executeTakeFirst();
        const opened = held
          ? undefined
          : await trx
              .selectFrom('BoxOpening')
              .select('boxItemId')
              .where('boxSourceKey', 'like', given)
              .where('userId', '=', userId)
              .executeTakeFirst();
        if (held || opened) return 'already' as const;
        await trx
          .insertInto('Item')
          .values(
            keysFor(userId).map((sourceKey) => ({
              itemDefinitionId: box.id,
              holderType: 'user',
              holderId: userId,
              sourceKey,
            }))
          )
          .execute();
        return 'granted' as const;
      });
    } catch (error) {
      if (isItemHolderBusy(error)) result.busyUserIds.push(userId);
      else {
        console.error('[mystery-box-grant] grant failed', { boxId: box.id, userId, error });
        result.failedUserIds.push(userId);
      }
      continue;
    }
    if (outcome === 'already') {
      result.alreadyGrantedUserIds.push(userId);
      continue;
    }
    result.grantedUserIds.push(userId);
    // Per user, as each commits: a later user's failure must not leave this grant unattributed.
    await recordModActivity({
      userId: moderatorId,
      entityType: 'user',
      entityId: userId,
      activity: `grantBox:${box.id}:${count}:${grantId}`,
    });
  }

  if (result.grantedUserIds.length)
    await recordModActivity({
      userId: moderatorId,
      entityType: 'mysteryBox',
      entityId: box.id,
      activity: `grantBox:${result.grantedUserIds.length}x${count}:${grantId}`,
    });
  return result;
}
