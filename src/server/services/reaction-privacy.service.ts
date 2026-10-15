import { IMAGE_REACTOR_LISTS_LAUNCHED_AT } from '@civitai/shared/reaction-privacy';
import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import {
  HIDDEN_REACTOR_ID,
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

export async function getUsersHiddenFromReactionLists(userIds: number[]) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Set<number>();
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id FROM "User"
    WHERE id IN (${Prisma.join(
      ids
    )}) AND settings -> ${HIDE_FROM_REACTION_LISTS_KEY}::text = 'true'::jsonb
  `;
  return new Set(rows.map((r) => r.id));
}

type NamedReaction = { user: { id: number; username: string | null } };

/**
 * Replaces opted-out reactors with an anonymous stand-in, in place. Rows stay, so every reaction count is unchanged;
 * the viewer's own reactions and a moderator's view are left as they are.
 */
export async function maskHiddenReactors(
  reactionLists: NamedReaction[][],
  viewer: { id: number; isModerator?: boolean } | undefined
) {
  if (viewer?.isModerator) return;
  const reactions = reactionLists.flat().filter((r) => r.user.id !== viewer?.id);
  const hidden = await getUsersHiddenFromReactionLists(reactions.map((r) => r.user.id));
  if (!hidden.size) return;
  for (const reaction of reactions)
    if (hidden.has(reaction.user.id)) reaction.user = { id: HIDDEN_REACTOR_ID, username: null };
}
