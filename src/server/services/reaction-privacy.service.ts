import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import {
  HIDDEN_REACTOR_ID,
  HIDE_FROM_REACTION_LISTS_KEY,
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
