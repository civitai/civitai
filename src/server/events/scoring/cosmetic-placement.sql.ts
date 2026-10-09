// Daily score for event cosmetics, computed in ClickHouse from the placement ledger mirrored into
// `event_cosmetic_placements`. One row per cosmetic INSTANCE (userId, cosmeticId, claimKey), so
// per-cosmetic, per-user and per-team totals are all sums of these rows.
//
// Rules, in the order the query applies them:
// - A placement counts only while it is on its owner's own content (entityOwnerId = userId), and
//   never for an owner who is banned or excluded from leaderboards (applied to the final rows).
// - An impression or reaction counts only inside a placement interval, and never from the owner.
// - Each viewer counts once per entity per day, credited to the cosmetic the entity wore when that
//   viewer first saw it that day, so rotating cosmetics through one entity does not multiply views.
//   Signed-in viewers are keyed by userId; signed-out viewers by the client-minted sessionKey.
// - Signed-in viewers and reactors registered within the new-account window, or banned / excluded
//   from leaderboards, count for nothing. userActivities records the affected user in targetUserId;
//   userId there is whoever performed the action (a moderator, or 0).
// - One viewer (or reactor) credits at most `viewerCap` entities per cosmetic owner per day.
// - Signed-out sessions that touched more than `botLimit` entities that day are dropped as bots. The
//   rest are capped per entity at max(anonFloor, signed viewers x anonRatio), and again per owner per
//   day at max(anonFloor, the owner's signed viewers x anonRatio), scaled down across their cosmetics.
// - A reaction counts once per (reactor, entity) for the whole event, on the day of its first
//   create, and only while at least one of that reactor's reactions on it is still active.
//
// Params (ClickHouse query_params): event, dayStart, dayEnd, eventStart, newAccountCutoff, botLimit,
// viewerCap, anonFloor, anonRatio.
export const cosmeticPlacementDailyScoreSql = /* sql */ `
WITH
  restrictedUsers AS (
    SELECT targetUserId AS userId FROM userActivities
    WHERE type IN ('Banned', 'Unbanned', 'ExcludedFromLeaderboard', 'UnexcludedFromLeaderboard')
    GROUP BY targetUserId
    HAVING argMaxIf(toString(type), time, type IN ('Banned', 'Unbanned')) = 'Banned'
      OR argMaxIf(toString(type), time, type IN ('ExcludedFromLeaderboard', 'UnexcludedFromLeaderboard')) = 'ExcludedFromLeaderboard'
  ),
  ineligibleViewers AS (
    SELECT targetUserId AS userId FROM userActivities
    WHERE type = 'Registration' AND time >= {newAccountCutoff:DateTime64(3)}
    UNION DISTINCT
    SELECT userId FROM restrictedUsers
  ),
  placements AS (
    SELECT
      userId, cosmeticId, claimKey, team, entityType, entityId, startedAt,
      ifNull(endedAt, toDateTime64('2100-01-01 00:00:00', 3, 'UTC')) AS endsAt
    FROM event_cosmetic_placements FINAL
    WHERE event = {event:String}
      AND startedAt < {dayEnd:DateTime64(3)}
      AND (endedAt IS NULL OR endedAt > {dayStart:DateTime64(3)})
      AND entityOwnerId = userId
  ),
  botSessions AS (
    SELECT sessionKey FROM impressions
    WHERE time >= {dayStart:DateTime64(3)} AND time < {dayEnd:DateTime64(3)}
      AND userId = 0 AND sessionKey != ''
    GROUP BY sessionKey
    HAVING uniqExact(entityType, entityId) > {botLimit:UInt32}
  ),
  -- ClickHouse inlines a CTE at every reference, so the impressions join is referenced exactly once:
  -- signed and signed-out viewers share one pass, and the per-viewer cap is a window over it.
  firstSight AS (
    SELECT entityType, entityId, viewerId, anonKey, argMin(hat, time) AS hat
    FROM (
      SELECT
        (p.userId, p.cosmeticId, p.claimKey, p.team) AS hat,
        i.entityType AS entityType, i.entityId AS entityId, i.userId AS viewerId,
        if(i.userId = 0, i.sessionKey, '') AS anonKey, i.time AS time
      FROM impressions AS i
      INNER JOIN placements AS p ON i.entityType = p.entityType AND i.entityId = p.entityId
      WHERE i.time >= {dayStart:DateTime64(3)} AND i.time < {dayEnd:DateTime64(3)}
        AND i.time >= p.startedAt AND i.time < p.endsAt
        AND i.userId != p.userId
    )
    WHERE (viewerId != 0 AND viewerId NOT IN (SELECT userId FROM ineligibleViewers))
      OR (viewerId = 0 AND anonKey != '' AND anonKey NOT IN (SELECT sessionKey FROM botSessions))
    GROUP BY entityType, entityId, viewerId, anonKey
  ),
  perEntity AS (
    SELECT hat, entityType, entityId,
      toUInt64(countIf(viewerId != 0)) AS signed, toUInt64(countIf(viewerId = 0)) AS anon
    FROM (
      SELECT hat, entityType, entityId, viewerId,
        row_number() OVER (PARTITION BY hat.1, viewerId ORDER BY entityType, entityId) AS rn
      FROM firstSight
    )
    WHERE viewerId = 0 OR rn <= {viewerCap:UInt32}
    GROUP BY hat, entityType, entityId
  ),
  perHat AS (
    SELECT hat, sum(signed) AS hatSigned,
      sum(least(anon, greatest(toUInt64({anonFloor:UInt32}), toUInt64(floor(signed * {anonRatio:Float64}))))) AS hatAnon
    FROM perEntity
    GROUP BY hat
  ),
  impressionScores AS (
    SELECT hat, hatSigned,
      if(ownerAnon <= ownerAnonCap, hatAnon, toUInt64(floor(hatAnon * ownerAnonCap / ownerAnon))) AS hatAnonCapped
    FROM (
      SELECT hat, hatSigned, hatAnon,
        sum(hatAnon) OVER (PARTITION BY hat.1) AS ownerAnon,
        greatest(toUInt64({anonFloor:UInt32}),
          toUInt64(floor(sum(hatSigned) OVER (PARTITION BY hat.1) * {anonRatio:Float64}))) AS ownerAnonCap
      FROM perHat
    )
  ),
  reactionState AS (
    SELECT
      if(type IN ('Image_Create', 'Image_Delete'), 'Image', 'Article') AS entityType,
      entityId, userId, reaction,
      minIf(time, type IN ('Image_Create', 'Article_Create')) AS firstCreate,
      argMax(type IN ('Image_Create', 'Article_Create'), time) AS active
    FROM reactions
    WHERE type IN ('Image_Create', 'Image_Delete', 'Article_Create', 'Article_Delete')
      AND time >= {eventStart:DateTime64(3)} AND time < {dayEnd:DateTime64(3)}
      -- Same result as filtering after the join, at a fraction of the group state.
      AND entityId IN (SELECT entityId FROM placements)
    GROUP BY entityType, entityId, userId, reaction
  ),
  firstReactions AS (
    SELECT entityType, entityId, userId, min(firstCreate) AS time
    FROM reactionState
    WHERE active = 1
    GROUP BY entityType, entityId, userId
    HAVING time >= {dayStart:DateTime64(3)}
  ),
  reactionsCapped AS (
    SELECT hat, reactorId, entityType, entityId
    FROM (
      -- DISTINCT: a placement row can be present twice until its ReplacingMergeTree merge lands.
      SELECT DISTINCT (p.userId, p.cosmeticId, p.claimKey, p.team) AS hat, r.userId AS reactorId,
        r.entityType AS entityType, r.entityId AS entityId
      FROM firstReactions AS r
      INNER JOIN placements AS p ON r.entityType = p.entityType AND r.entityId = p.entityId
      WHERE r.time >= p.startedAt AND r.time < p.endsAt
        AND r.userId != p.userId
        AND r.userId NOT IN (SELECT userId FROM ineligibleViewers)
    )
    ORDER BY hat.1, reactorId, entityType, entityId
    LIMIT {viewerCap:UInt32} BY hat.1, reactorId
  )
SELECT
  hat.1 AS userId, hat.2 AS cosmeticId, hat.3 AS claimKey, hat.4 AS team,
  toUInt64(sum(impressions)) AS impressions,
  toUInt64(sum(anonImpressions)) AS anonImpressions,
  toUInt64(sum(reactions)) AS reactions
FROM (
  SELECT hat, hatSigned AS impressions, hatAnonCapped AS anonImpressions, toUInt64(0) AS reactions
  FROM impressionScores
  UNION ALL
  SELECT hat, toUInt64(0), toUInt64(0), toUInt64(count()) FROM reactionsCapped GROUP BY hat
)
-- Restricted owners are dropped here, once, rather than inside placements: ClickHouse inlines a CTE at
-- every reference, and placements is referenced three times.
WHERE hat.1 NOT IN (SELECT userId FROM restrictedUsers)
GROUP BY hat
`;
