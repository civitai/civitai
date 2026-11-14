import { refereeCreditCtes, seasonRowsCte } from '~/server/events/points/referee.sql';

// What one person's placed hats have earned since each went on what it is on now, by the referee's
// own CTEs, so it matches scoring. Read only the rows that can credit this owner: their hats' rows
// and the turf rows that name them, which share their daily limit with their hats.
//
// A day's limit is filled per (owner, person) in the referee's order (first time, type, entity), and
// every credit keeps the points it was granted, so the points of one hat on one entity are the sum of
// its own credits: deterministic, and never more than the hat earned over the same span.
//
// Restricted people are left out by the caller, per actor: the referee's limit is per (day, owner,
// actor), so dropping an actor afterwards is the same as never reading them. The query runs with no
// one restricted and returns one row per (hat, actor).
//
// Params: the referee's (recomputeFrom = the UTC day of the earliest placement), plus userId and
// placements: Array(Tuple(cosmeticId, claimKey, entityType, entityId, startedAt)).
export const hatPlacementStatsSql = /* sql */ `
WITH
${seasonRowsCte(`
      AND (ownerId = {userId:Int32} OR (ownerId = 0 AND has(players, {userId:Int32})))`)}${refereeCreditCtes},
  placements AS (
    SELECT p.1 AS pCosmeticId, p.2 AS pClaimKey, p.3 AS pEntityType, p.4 AS pEntityId, p.5 AS pStartedAt
    FROM (
      SELECT arrayJoin({placements:Array(Tuple(Int32, String, String, Int32, DateTime64(3)))}) AS p
    )
  ),
  mine AS (
    SELECT type, actorId, entityType, entityId, firstTime, granted,
      hat.2 AS hatCosmeticId, hat.3 AS hatClaimKey
    FROM credited
    WHERE hat.1 = {userId:Int32}
  )
SELECT
  hatCosmeticId AS cosmeticId, hatClaimKey AS claimKey, actorId,
  toUInt64(sum(granted)) AS hatPoints,
  toUInt64(sumIf(granted, onEntity)) AS points,
  toUInt64(countIf(type = 'view' AND granted > 0 AND onEntity)) AS views
FROM (
  SELECT *, entityType = pEntityType AND entityId = pEntityId AS onEntity
  FROM mine
  INNER JOIN placements ON hatCosmeticId = pCosmeticId AND hatClaimKey = pClaimKey
  WHERE firstTime >= pStartedAt
)
GROUP BY cosmeticId, claimKey, actorId
HAVING hatPoints > 0
`;
