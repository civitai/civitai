import { IMAGE_REACTOR_LISTS_LAUNCHED_AT } from '@civitai/shared/reaction-privacy';
import { Prisma } from '@prisma/client';
import {
  HIDE_FROM_REACTION_LISTS_KEY,
  SHOW_PRE_LAUNCH_REACTIONS_KEY,
} from '~/shared/constants/reaction-privacy.constants';

/**
 * SQL predicate: the user in `userIdColumn` may be named to `viewerId`. False only for someone else who opted out;
 * a viewer always sees their own entry.
 */
export function listedToViewer(userIdColumn: Prisma.Sql, viewerId: number | undefined) {
  return Prisma.sql`(${userIdColumn} = ${viewerId ?? null}::int OR NOT EXISTS (
    SELECT 1 FROM "User" hidden WHERE hidden.id = ${userIdColumn}
      AND hidden.settings -> ${HIDE_FROM_REACTION_LISTS_KEY}::text = 'true'::jsonb
  ))`;
}

/**
 * SQL predicate for image "who reacted" lists, on `"ImageReaction"` rows: `listedToViewer`, and a reaction made
 * before those lists launched only when its reactor opted in to showing it.
 *
 * The opt-in set is one InitPlan over the partial index `User_showPreLaunchReactions_idx`, whose predicate names the
 * key literally (hence `Prisma.raw`); a per-row lookup costs a `User` probe for every older reaction on the image.
 */
export function imageReactionListedToViewer(viewerId: number | undefined) {
  const userId = Prisma.raw('"ImageReaction"."userId"');
  return Prisma.sql`(${listedToViewer(userId, viewerId)} AND (
    ${userId} = ${viewerId ?? null}::int
    OR "ImageReaction"."createdAt" >= ${IMAGE_REACTOR_LISTS_LAUNCHED_AT}::timestamp
    OR ${userId} = ANY(ARRAY(
      SELECT id FROM "User" WHERE settings -> ${Prisma.raw(
        `'${SHOW_PRE_LAUNCH_REACTIONS_KEY}'`
      )}::text = 'true'::jsonb
    ))
  ))`;
}
