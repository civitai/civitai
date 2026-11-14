// How many signed-in views each of one person's placed hats has had on what it is on now, since it
// went on. A view row is written once per viewer, entity and UTC day, so this counts viewer-days.
// One scan from the earliest placement on, narrowed by ownerId (the sort key's third column) on
// every day; no season-wide read, so it is safe on the hats page. Counts views, not points: points
// depend on the owner's other content and turf through the daily limit, which this does not read.
//
// Params: event, userId, from (the earliest placement's startedAt), to (now), and
// placements: Array(Tuple(cosmeticId, claimKey, entityType, entityId, startedAt)).
export const hatPlacementViewsSql = /* sql */ `
SELECT v.cosmeticId AS cosmeticId, v.claimKey AS claimKey, count() AS views
FROM (
  SELECT cosmeticId, claimKey, entityType, entityId, time
  FROM event_point_events
  WHERE event = {event:String}
    AND ownerId = {userId:Int32}
    AND time >= {from:DateTime64(3)} AND time < {to:DateTime64(3)}
    AND type = 'view' AND op = 'add'
    AND actorId != ownerId
    -- Set lookups, built once: a per-row scan of every placement timed out on a big owner.
    AND entityId IN (SELECT arrayJoin(arrayMap(p -> p.4, {placements:Array(Tuple(Int32, String, String, Int32, DateTime64(3)))})))
    AND (cosmeticId, claimKey, entityType, entityId) IN (
      SELECT arrayJoin(arrayMap(p -> (p.1, p.2, p.3, p.4), {placements:Array(Tuple(Int32, String, String, Int32, DateTime64(3)))}))
    )
) AS v
-- A hat's latest placement only, joined on its entity too: if a move left two open rows for one hat,
-- a view of the old entity neither counts nor counts twice.
INNER JOIN (
  SELECT cosmeticId, claimKey, current.1 AS entityType, current.2 AS entityId, current.3 AS startedAt
  FROM (
    SELECT p.1 AS cosmeticId, p.2 AS claimKey, argMax((p.3, p.4, p.5), p.5) AS current
    FROM (SELECT arrayJoin({placements:Array(Tuple(Int32, String, String, Int32, DateTime64(3)))}) AS p)
    GROUP BY cosmeticId, claimKey
  )
) AS s ON v.cosmeticId = s.cosmeticId AND v.claimKey = s.claimKey
  AND v.entityType = s.entityType AND v.entityId = s.entityId
WHERE v.time >= s.startedAt
GROUP BY v.cosmeticId, v.claimKey
`;
