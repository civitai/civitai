import type { dbRead } from '~/server/db/client';
import { dbWrite } from '~/server/db/client';
import { canPlayEvent, getEventAccess } from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';

export type TeamRemixWaiver = { event: string; team: string; perDay: number };

/**
 * The event waiver that makes this remix submission free, or null.
 *
 * All of these, for one event with `scoring.teamRemixWaiver`:
 * - the event is playable for the placer now (its dates and its flag, as `assertPlayable` reads);
 * - the host image wears that event's hat, placed by its owner on their own image;
 * - the placer and the owner have both JOINED the same team: each holds the event's join cosmetic
 *   in that team's colour. `getUserTeam` is not enough, since it names a team for anyone.
 *
 * That the remix was verifiably made from the host image, and the per-day limit, are the caller's:
 * the first is a fact about the submission, the second is counted under the claim's lock.
 *
 * `db` is the primary on the mutation, so a hat taken off or a join made seconds ago is seen.
 */
export async function findTeamRemixWaiver({
  placerId,
  ownerId,
  hostImageId,
  now = new Date(),
  db = dbWrite,
}: {
  placerId: number;
  ownerId: number;
  hostImageId: number;
  now?: Date;
  db?: typeof dbRead | typeof dbWrite;
}): Promise<TeamRemixWaiver | null> {
  if (placerId === ownerId) return null;

  for (const def of await loadEvents()) {
    const perDay = def.scoring?.teamRemixWaiver?.perPlacerPerDay;
    if (!perDay || !def.join) continue;
    if (!canPlayEvent(await getEventAccess(def, { id: placerId }, now))) continue;

    const [hat] = await db.$queryRaw<{ hatted: number }[]>`
      SELECT 1 AS hatted
      FROM "EventCosmeticPlacement" p
      WHERE p.event = ${def.name}
        AND p."entityType" = 'Image'
        AND p."entityId" = ${hostImageId}
        AND p."endedAt" IS NULL
        AND p."userId" = ${ownerId}
        AND p."entityOwnerId" = ${ownerId}
      LIMIT 1
    `;
    if (!hat) continue;

    const joined = await db.$queryRaw<{ userId: number; team: string }[]>`
      SELECT uc."userId", c.data->>'team' AS team
      FROM "UserCosmetic" uc
      JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
      WHERE uc."userId" IN (${placerId}, ${ownerId})
        AND uc."claimKey" = ${def.join.claimKey}
        AND c.data->>'event' = ${def.name}
        AND c.data->>'design' = ${def.join.design}
        AND c.data->>'team' IS NOT NULL
    `;
    const placerTeams = new Set(joined.filter((r) => r.userId === placerId).map((r) => r.team));
    const team = joined.find((r) => r.userId === ownerId && placerTeams.has(r.team))?.team;
    if (team) return { event: def.name, team, perDay };
  }
  return null;
}
