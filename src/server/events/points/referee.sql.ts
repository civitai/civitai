// The referee: exact per-hat, per-day points for one season of a scored event, computed from the
// points ledger alone. The live totals in sysRedis are reset to this every run.
//
// Rules, in the order the query applies them:
// - Only rows in [seasonStart, cut) count.
// - A sourceId names one (kind, entity, person), e.g. one person's reactions on one image. Its adds
//   count only while its latest row is an add: removing the last reaction nets it out, reacting
//   again brings it back.
// - Actors banned or excluded from leaderboards (their latest state), or registered within the
//   new-account window, earn nobody anything. userActivities records the affected user in
//   targetUserId. Owners banned or excluded earn nothing either.
// - Each person counts once per (type, entity) for the whole season, or once per UTC day for types
//   listed in dailyTypes; the earliest surviving add is the one kept, with the hat it was on.
// - Each kept action is worth its type's weight. Per (UTC day, owner, person), in time order, weights
//   are credited until the cap; the action that crosses it gets what was left.
//
// Params: event, seasonStart, cut, newAccountCutoff, cap, types (Array(String)),
// weights (Array(UInt32), aligned with types), dailyTypes (Array(String)).
export const eventPointsRefereeSql = /* sql */ `
WITH
  restrictedUsers AS (
    SELECT targetUserId AS userId FROM userActivities
    WHERE type IN ('Banned', 'Unbanned', 'ExcludedFromLeaderboard', 'UnexcludedFromLeaderboard')
    GROUP BY targetUserId
    HAVING argMaxIf(toString(type), time, type IN ('Banned', 'Unbanned')) = 'Banned'
      OR argMaxIf(toString(type), time, type IN ('ExcludedFromLeaderboard', 'UnexcludedFromLeaderboard')) = 'ExcludedFromLeaderboard'
  ),
  newAccounts AS (
    SELECT targetUserId AS userId FROM userActivities
    WHERE type = 'Registration' AND time >= {newAccountCutoff:DateTime64(3)}
  ),
  seasonRows AS (
    SELECT * FROM event_point_events
    WHERE event = {event:String}
      AND time >= {seasonStart:DateTime64(3)} AND time < {cut:DateTime64(3)}
  ),
  firsts AS (
    SELECT
      type, actorId, entityType, entityId,
      if(has({dailyTypes:Array(String)}, type), toDate(time), toDate(0)) AS onceKey,
      min(time) AS firstTime,
      argMin((ownerId, cosmeticId, claimKey, team), time) AS hat
    FROM seasonRows
    WHERE op = 'add'
      AND (sourceId = '' OR sourceId IN (
        SELECT sourceId FROM seasonRows WHERE sourceId != ''
        GROUP BY sourceId HAVING argMax(op, time) = 'add'
      ))
      AND actorId NOT IN (SELECT userId FROM restrictedUsers)
      AND actorId NOT IN (SELECT userId FROM newAccounts)
      AND ownerId NOT IN (SELECT userId FROM restrictedUsers)
    GROUP BY type, actorId, entityType, entityId, onceKey
  ),
  weighted AS (
    SELECT
      type, actorId, entityType, entityId, firstTime, hat,
      toDate(firstTime) AS day,
      toInt64(transform(type, {types:Array(String)}, {weights:Array(UInt32)}, toUInt32(0))) AS weight
    FROM firsts
  ),
  credited AS (
    SELECT *,
      greatest(toInt64(0),
        least(toInt64({cap:UInt32}), running) - least(toInt64({cap:UInt32}), running - weight)
      ) AS points
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
  hat.1 AS userId, hat.2 AS cosmeticId, hat.3 AS claimKey, hat.4 AS team,
  toUInt64(sum(points)) AS points,
  toUInt64(countIf(type = 'view' AND points > 0)) AS views,
  toUInt64(countIf(type = 'reaction' AND points > 0)) AS reactions,
  toUInt64(countIf(type = 'comment' AND points > 0)) AS comments,
  toUInt64(countIf(type = 'sticker' AND points > 0)) AS stickers,
  toUInt64(countIf(type = 'remix' AND points > 0)) AS remixes,
  toUInt64(countIf(type = 'modelLike' AND points > 0)) AS modelLikes
FROM credited
GROUP BY day, hat
ORDER BY day, userId, cosmeticId, claimKey
`;
