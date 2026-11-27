// The referee query split by actor. A leaf module, so scripts/check-event-points-sql.mjs runs the
// same merge against a real ClickHouse that the settle job runs.
//
// Every rule of the query is per actor: firsts, sourceId netting, the restricted and new-account
// filters, the self-hat rule, turf credits, and the cap (per day, owner and actor). So the rows of
// one actor never meet another actor's before the final GROUP BY, which only sums. Running the query
// once per actor shard and summing the rows per (day, hat) gives the single query's answer, while
// each run holds only its shard's share of the season's firsts in memory.

// Shards per settle, hourly and whole-season alike: both read the whole season of non-daily types.
// Each shard rescans the ledger, so more shards cost time against REFEREE_CLICKHOUSE_BUDGET_S.
export const REFEREE_ACTOR_SHARDS = 4;

export type RefereeRow = {
  day: string;
  userId: number;
  cosmeticId: number;
  claimKey: string;
  team: string;
  points: number;
  views: number;
  reactions: number;
  comments: number;
  stickers: number;
  remixes: number;
  modelLikes: number;
  // UTC hour (0-23) -> points granted in it.
  hours: Record<number, number>;
};

const COUNTS = [
  'points',
  'views',
  'reactions',
  'comments',
  'stickers',
  'remixes',
  'modelLikes',
] as const satisfies readonly (keyof RefereeRow)[];

// A row as ClickHouse's JSONEachRow sends it: UInt64 columns arrive as strings.
export function parseRefereeRow(r: Record<string, unknown>): RefereeRow {
  const hours = (r.hours ?? {}) as Record<string, unknown>;
  return {
    day: String(r.day),
    userId: Number(r.userId),
    cosmeticId: Number(r.cosmeticId),
    claimKey: String(r.claimKey),
    team: String(r.team),
    points: Number(r.points),
    views: Number(r.views),
    reactions: Number(r.reactions),
    comments: Number(r.comments),
    stickers: Number(r.stickers),
    remixes: Number(r.remixes),
    modelLikes: Number(r.modelLikes),
    hours: Object.fromEntries(
      Object.entries(hours).map(([hour, points]) => [Number(hour), Number(points)])
    ),
  };
}

const compare = (a: RefereeRow, b: RefereeRow) =>
  a.day < b.day
    ? -1
    : a.day > b.day
    ? 1
    : a.userId - b.userId ||
      a.cosmeticId - b.cosmeticId ||
      (a.claimKey < b.claimKey ? -1 : a.claimKey > b.claimKey ? 1 : 0);

// Sums shards into one row per (day, hat), in the query's ORDER BY. Each shard returns nearly every
// (day, hat), so a shard is folded in as it arrives rather than all of them held at once. The team is
// any() in the query, so here the first shard's is kept.
export function refereeShardMerge() {
  const merged = new Map<string, RefereeRow>();
  return {
    add(raw: Record<string, unknown>[]) {
      for (const r of raw) {
        const row = parseRefereeRow(r);
        // claimKey last: the other parts cannot contain the separator.
        const key = `${row.day}|${row.userId}|${row.cosmeticId}|${row.claimKey}`;
        const into = merged.get(key);
        if (!into) {
          merged.set(key, row);
          continue;
        }
        for (const column of COUNTS) into[column] += row[column];
        for (const [hour, points] of Object.entries(row.hours))
          into.hours[Number(hour)] = (into.hours[Number(hour)] ?? 0) + points;
      }
    },
    rows: () => [...merged.values()].sort(compare),
  };
}
