/**
 * One-off backfill: a model the user recommended through a review surface (the version card's
 * thumbs, the reviews page, the post editor) is added to their Liked Models collection. Only
 * `user.toggleFavorite` wrote to that collection before, so those likes never reached it.
 *
 * A row is added for each (user, model) with a review written since `--since` that counts as a
 * like (recommended, not excluded, no TOS violation: the rule `syncLikedModel` applies live), on
 * a model the live add accepts (`assertCollectionItemsVisibleToViewer`: the user's own model, or
 * a published, non-private, not taken down, non-POI model whose owner does not block them), and
 * not yet in the user's Model bookmark collection. A user with no such collection gets one first.
 * Rows are derived by query at run time; this file holds no ids. Both inserts skip what already
 * exists, so a re-run (or a chunk a live like already covered) adds nothing twice.
 *
 * Added items carry `note = BACKFILL_NOTE`, so they can be counted and removed again:
 *   DELETE FROM "CollectionItem" WHERE note = '<BACKFILL_NOTE>';
 * Collections it created are left in place; the app creates the same collection on first read.
 *
 * Usage:
 *   pnpm run tsscript scripts/oneoffs/backfill-liked-models.ts                   # dry run: counts only
 *   pnpm run tsscript scripts/oneoffs/backfill-liked-models.ts --apply --limit-chunks 1
 *   pnpm run tsscript scripts/oneoffs/backfill-liked-models.ts --apply           # the rest
 *
 * Options:
 *   --apply              Write. Without it nothing is written.
 *   --since <date>       Reviews written on or after this date (default 2026-08-19).
 *   --chunk <n>          Review ids per step, 1-50000 (default 10000).
 *   --pause-ms <n>       Pause between chunks (default 500).
 *   --from <id>          Resume after this review id (the cursor every chunk prints).
 *   --limit-chunks <n>   Stop after n chunks.
 */
import { Prisma } from '@prisma/client';
import { publishedModelSql } from '~/server/services/collection-cover-visibility';

export const SCRIPT_BASENAME = 'backfill-liked-models';
export const BACKFILL_NOTE = 'Backfilled from a review like (2026-11)';
const MAX_CHUNK = 50_000;

export type RunOptions = {
  apply: boolean;
  since: Date;
  chunk: number;
  pauseMs: number;
  from?: number;
  limitChunks?: number;
};

export function parseArgs(argv: string[]): RunOptions {
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const raw = argv[i + 1];
    if (raw === undefined || raw.startsWith('--')) throw new Error(`--${name} needs a value`);
    return raw;
  };
  const int = (name: string, min: number, max: number) => {
    const raw = value(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`--${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  const since = new Date(value('since') ?? '2026-08-19');
  if (Number.isNaN(since.getTime())) throw new Error('--since must be a date');
  return {
    apply: argv.includes('--apply'),
    since,
    chunk: int('chunk', 1, MAX_CHUNK) ?? 10_000,
    pauseMs: int('pause-ms', 0, 60_000) ?? 500,
    from: int('from', 0, 2_147_483_647),
    limitChunks: int('limit-chunks', 1, 1_000_000),
  };
}

/** The (user, model) pairs a chunk of review ids should add, one row per pair. */
function missingLikesSql(since: Date, after: number, upTo: number) {
  return Prisma.sql`
    SELECT DISTINCT ON (r."userId", r."modelId") r."userId", r."modelId", r."createdAt"
    FROM "ResourceReview" r
    JOIN "Model" m ON m.id = r."modelId" AND m."deletedAt" IS NULL
    WHERE r.id > ${after} AND r.id <= ${upTo}
      AND r."createdAt" >= ${since}
      AND r.recommended AND NOT r.exclude AND NOT r."tosViolation"
      AND (
        m."userId" = r."userId"
        OR (
          ${publishedModelSql} AND m.poi IS NOT TRUE
          AND NOT EXISTS (
            SELECT 1 FROM "UserEngagement" ue
            WHERE ue."userId" = m."userId" AND ue."targetUserId" = r."userId" AND ue.type = 'Block'
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        JOIN "Collection" c ON c.id = ci."collectionId"
        WHERE c."userId" = r."userId" AND c.type = 'Model' AND c.mode = 'Bookmark'
          AND ci."modelId" = r."modelId"
      )
    ORDER BY r."userId", r."modelId", r."createdAt"`;
}

export function countSql(since: Date, after: number, upTo: number) {
  return Prisma.sql`
    SELECT count(*)::int AS pairs, count(DISTINCT "userId")::int AS users
    FROM (${missingLikesSql(since, after, upTo)}) missing`;
}

export function ensureCollectionsSql(since: Date, after: number, upTo: number) {
  return Prisma.sql`
    INSERT INTO "Collection" ("userId", name, description, type, mode)
    SELECT DISTINCT missing."userId", 'Liked Models', 'Your liked models will appear in this collection.',
      'Model'::"CollectionType", 'Bookmark'::"CollectionMode"
    FROM (${missingLikesSql(since, after, upTo)}) missing
    WHERE NOT EXISTS (
      SELECT 1 FROM "Collection" c
      WHERE c."userId" = missing."userId" AND c.type = 'Model' AND c.mode = 'Bookmark'
    )
    ON CONFLICT DO NOTHING`;
}

export function insertItemsSql(since: Date, after: number, upTo: number) {
  return Prisma.sql`
    INSERT INTO "CollectionItem" ("collectionId", "modelId", "addedById", "createdAt", note)
    SELECT c.id, missing."modelId", missing."userId", missing."createdAt", ${BACKFILL_NOTE}
    FROM (${missingLikesSql(since, after, upTo)}) missing
    JOIN LATERAL (
      SELECT id FROM "Collection" c
      WHERE c."userId" = missing."userId" AND c.type = 'Model' AND c.mode = 'Bookmark'
      ORDER BY id LIMIT 1
    ) c ON true
    ON CONFLICT DO NOTHING`;
}

export function boundsSql(since: Date) {
  return Prisma.sql`
    SELECT
      (SELECT id FROM "ResourceReview" WHERE "createdAt" >= ${since} ORDER BY id LIMIT 1) AS first,
      (SELECT max(id) FROM "ResourceReview") AS last`;
}

export type Deps = {
  read: <T>(sql: Prisma.Sql) => Promise<T[]>;
  write: (sql: Prisma.Sql) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

export async function run(options: RunOptions, deps: Deps) {
  const [bounds] = await deps.read<{ first: number | null; last: number | null }>(
    boundsSql(options.since)
  );
  if (bounds?.first == null || bounds.last == null) {
    deps.log('no reviews since the cutoff');
    return { pairs: 0, users: 0, added: 0 };
  }
  let cursor = options.from ?? bounds.first - 1;
  let chunks = 0;
  const totals = { pairs: 0, users: 0, added: 0 };
  while (cursor < bounds.last) {
    const upTo = Math.min(cursor + options.chunk, bounds.last);
    const [count] = await deps.read<{ pairs: number; users: number }>(
      countSql(options.since, cursor, upTo)
    );
    totals.pairs += count.pairs;
    totals.users += count.users;
    if (options.apply && count.pairs > 0) {
      await deps.write(ensureCollectionsSql(options.since, cursor, upTo));
      totals.added += await deps.write(insertItemsSql(options.since, cursor, upTo));
    }
    cursor = upTo;
    chunks += 1;
    deps.log(
      `ids <= ${cursor}: ${count.pairs} missing (${count.users} users)` +
        (options.apply ? `, ${totals.added} added so far` : '') +
        ` (resume with --from ${cursor})`
    );
    if (options.limitChunks && chunks >= options.limitChunks) break;
    await deps.sleep(options.pauseMs);
  }
  deps.log(
    `${options.apply ? 'done' : 'dry run, nothing written'}: ${totals.pairs} missing likes` +
      ` (users summed per chunk: ${totals.users})` +
      (options.apply ? `, ${totals.added} items added` : '')
  );
  return totals;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { dbRead, dbWrite } = await import('~/server/db/client');
  // The dry run reads the replica; an apply reads the primary, which its own writes land on.
  const reader = options.apply ? dbWrite : dbRead;
  await run(options, {
    read: <T>(sql: Prisma.Sql) => reader.$queryRaw<T[]>(sql),
    write: (sql) => dbWrite.$executeRaw(sql),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  });
}

// Only when run as a script: importing the builders above must not start a run.
if (process.argv[1]?.includes(SCRIPT_BASENAME)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
