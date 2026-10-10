// The referee: exact per-hat, per-day points for one season of a scored event, computed from the
// points ledger alone. The live totals in sysRedis are reset to this every run.
//
// It recomputes only the days from recomputeFrom (the hourly run: yesterday and today; the nightly
// run: the whole season). Earlier days are final and read from the Postgres snapshot instead. Daily
// types (views) are read only for the recomputed days; everything else is read for the whole season,
// because whether an action is a first depends on the whole season.
//
// Rules, in the order the query applies them:
// - Adds count only in [seasonStart, cut). Removals are read on to removeCut, past the season's end
//   through the finalize window, so a late takedown still nets out its add.
// - A sourceId names one (kind, entity, person), e.g. one person's reactions on one image. Its adds
//   count only while its latest row is an add: removing the last reaction nets it out, reacting
//   again brings it back.
// - People in restrictedUsers (banned, deleted, excluded from leaderboards) neither give nor earn.
//   Actors with an id from newAccountMinId (registered inside the new-account window) give nothing.
//   Both are read from Postgres "User" by the caller.
// - Nobody earns from acting on their own hat.
// - Each person counts once per (type, entity) for the whole season, or once per UTC day for types
//   listed in dailyTypes; the earliest surviving add is the one kept, with the hat it was on.
// - Each kept action is worth its type's weight. Per (UTC day, owner, person), in time order, weights
//   are credited until the cap; the action that crosses it gets what was left.
//
// Params: event, seasonStart, recomputeFrom, cut, removeCut, cap, types (Array(String)), weights (Array(UInt32),
// aligned with types), dailyTypes (Array(String)), restrictedUsers (Array(Int32)), newAccountMinId.
export const eventPointsRefereeSql = /* sql */ `
WITH
  seasonRows AS (
    SELECT * FROM event_point_events
    WHERE event = {event:String}
      AND time >= {seasonStart:DateTime64(3)} AND time < {removeCut:DateTime64(3)}
      AND (NOT has({dailyTypes:Array(String)}, type) OR time >= {recomputeFrom:DateTime64(3)})
  ),
  firsts AS (
    SELECT
      type, actorId, entityType, entityId,
      if(has({dailyTypes:Array(String)}, type), toDate(time), toDate(0)) AS onceKey,
      min(time) AS firstTime,
      argMin((ownerId, cosmeticId, claimKey, team), time) AS hat
    FROM seasonRows
    WHERE op = 'add' AND time < {cut:DateTime64(3)}
      AND (sourceId = '' OR (type, actorId, sourceId) IN (
        SELECT type, actorId, sourceId FROM seasonRows WHERE sourceId != ''
        GROUP BY type, actorId, sourceId HAVING argMax(op, time) = 'add'
      ))
      -- NOT IN builds a hash set; has() scans the array for every row.
      AND actorId NOT IN {restrictedUsers:Array(Int32)}
      AND ownerId NOT IN {restrictedUsers:Array(Int32)}
      AND actorId < {newAccountMinId:Int32}
      AND actorId != ownerId
    GROUP BY type, actorId, entityType, entityId, onceKey
  ),
  weighted AS (
    SELECT
      type, actorId, entityType, entityId, firstTime, hat,
      toDate(firstTime) AS day,
      toInt64(transform(type, {types:Array(String)}, {weights:Array(UInt32)}, toUInt32(0))) AS weight
    FROM firsts
    -- Days before recomputeFrom are final. The cap's window is per day, so dropping them here
    -- changes no recomputed day and spares the window function the whole season.
    WHERE day >= toDate({recomputeFrom:DateTime64(3)})
  ),
  credited AS (
    SELECT *,
      greatest(toInt64(0),
        least(toInt64({cap:UInt32}), running) - least(toInt64({cap:UInt32}), running - weight)
      ) AS granted
    FROM (
      SELECT *,
        sum(weight) OVER (
          PARTITION BY day, hat.1, actorId
          ORDER BY firstTime, type, entityType, entityId
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS running
      FROM weighted
    )
  )
SELECT
  day,
  hat.1 AS userId, hat.2 AS cosmeticId, hat.3 AS claimKey,
  -- One row per hat per day: the snapshot's key has no team, so a hat never splits across two.
  any(hat.4) AS team,
  toUInt64(sum(granted)) AS points,
  toUInt64(countIf(type = 'view' AND granted > 0)) AS views,
  toUInt64(countIf(type = 'reaction' AND granted > 0)) AS reactions,
  toUInt64(countIf(type = 'comment' AND granted > 0)) AS comments,
  toUInt64(countIf(type = 'sticker' AND granted > 0)) AS stickers,
  toUInt64(countIf(type = 'remix' AND granted > 0)) AS remixes,
  toUInt64(countIf(type = 'modelLike' AND granted > 0)) AS modelLikes
FROM credited
GROUP BY day, userId, cosmeticId, claimKey
ORDER BY day, userId, cosmeticId, claimKey
`;

// Everyone the recomputed rows could credit or be credited by, so their accounts can be checked in
// Postgres. Same window as the query above.
export const eventPointsRefereeUsersSql = /* sql */ `
SELECT groupUniqArray(actorId) AS actors, groupUniqArray(ownerId) AS owners
FROM event_point_events
WHERE event = {event:String}
  AND time >= {seasonStart:DateTime64(3)} AND time < {cut:DateTime64(3)}
  AND (NOT has({dailyTypes:Array(String)}, type) OR time >= {recomputeFrom:DateTime64(3)})
`;
