/**
 * Copies the blocklist's live CSAM entries (ClickHouse `blocked_images`) into Postgres "BlockedImage",
 * the table review routing reads (`suspectImageSql`), wherever the copy is missing. Kept as the
 * repair for a copy the blocklist writers failed to make: re-run the dry run, then apply with
 * --expect.
 *
 * Usage:
 *   pnpm run tsscript scripts/oneoffs/reconcile-held-media-blocked-hashes.ts
 *   pnpm run tsscript scripts/oneoffs/reconcile-held-media-blocked-hashes.ts --apply --expect <n>
 *
 * Without --apply it is a dry run: it reads ClickHouse and the Postgres replica
 * (`DATABASE_REPLICA_URL`) and needs no write credential. --apply writes through `DATABASE_URL`,
 * refuses unless the count to copy equals --expect, then reads the replica back. Prints counts only.
 *
 * Copies only; never deletes. A Postgres row the blocklist no longer holds as live is counted as
 * stale and left: it only routes an image to the CSAM review tier.
 */
import { PrismaClient } from '@prisma/client';
import { mirrorBlockedHashesSql } from '@civitai/shared/held-media';

/** Pinned against this file's own name by a test; see the entrypoint guard at the end. */
export const SCRIPT_BASENAME = 'reconcile-held-media-blocked-hashes';

/** Hashes whose newest row is a live CSAM entry: the app's own argMax and tie-break. */
export const LIVE_CSAM_SQL = `SELECT toString(hash) AS hash FROM (
  SELECT hash, argMax(tuple(reason, disabled), tuple(created_at, reason = 'CSAM' AND disabled = false)) AS newest
  FROM blocked_images
  WHERE hash IN (SELECT hash FROM blocked_images WHERE reason = 'CSAM')
  GROUP BY hash
) WHERE tupleElement(newest, 1) = 'CSAM' AND tupleElement(newest, 2) = false`;

export const PG_CSAM_SQL = `SELECT hash::text AS hash FROM "BlockedImage" WHERE reason = 'CSAM'`;
/** How many of the hashes in $1 (text) are CSAM rows. */
export const PG_COPIED_COUNT_SQL = `SELECT count(*)::int AS count FROM "BlockedImage" WHERE reason = 'CSAM' AND hash = ANY($1::text[]::bigint[])`;

const BATCH = 500;
const READBACK_TRIES = 10;
const READBACK_WAIT_MS = 3_000;

export type Options = { apply: boolean; expect: number | null };

export function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  const opts: Options = { apply: false, expect: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--expect') {
      const n = Number(args[++i]);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('--expect takes a count');
      opts.expect = n;
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (opts.apply && opts.expect === null) throw new Error('--apply needs --expect <n>');
  return opts;
}

export function plan(live: string[], pgCsam: string[]) {
  const liveSet = new Set(live);
  const pgSet = new Set(pgCsam);
  return {
    live: liveSet.size,
    pg: pgSet.size,
    missing: [...liveSet].filter((hash) => !pgSet.has(hash)),
    stale: [...pgSet].filter((hash) => !liveSet.has(hash)).length,
  };
}

export type Deps = {
  readLive: () => Promise<string[]>;
  readPg: () => Promise<string[]>;
  /** How many of these hashes the replica holds as CSAM rows. */
  readCopied: (hashes: string[]) => Promise<number>;
  /** Only built for --apply, so a dry run holds no write client. */
  writer: () => { execute: (sql: string) => Promise<unknown> };
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
};

export async function run(opts: Options, deps: Deps) {
  const [live, pgCsam] = await Promise.all([deps.readLive(), deps.readPg()]);
  if (!live.length) throw new Error('the blocklist returned no live CSAM entries; refusing to run');
  const p = plan(live, pgCsam);
  deps.log(
    `live in blocklist: ${p.live}; in Postgres: ${p.pg}; to copy: ${p.missing.length}; ` +
      `stale in Postgres (left): ${p.stale}`
  );
  if (!opts.apply) {
    deps.log('dry run: nothing written');
    return p;
  }
  if (p.missing.length !== opts.expect)
    throw new Error(
      `refusing to write: ${p.missing.length} to copy, --expect ${opts.expect}. Re-run the dry run.`
    );
  const writer = deps.writer();
  for (let i = 0; i < p.missing.length; i += BATCH) {
    const sql = mirrorBlockedHashesSql(p.missing.slice(i, i + BATCH));
    if (sql) await writer.execute(sql);
  }
  deps.log(`copied: ${p.missing.length}`);

  // The replica must show every copied hash before the run reports success.
  for (let tries = 1; ; tries++) {
    const count = await deps.readCopied(p.missing);
    deps.log(`replica readback: ${count} of ${p.missing.length} copied`);
    if (count === p.missing.length) return p;
    if (tries >= READBACK_TRIES) throw new Error('replica readback is short of the copied count');
    await deps.sleep(READBACK_WAIT_MS);
  }
}

async function readLiveFromClickhouse(): Promise<string[]> {
  const host = process.env.CLICKHOUSE_HOST;
  const username = process.env.CLICKHOUSE_USERNAME;
  if (!host || !username) throw new Error('CLICKHOUSE_HOST and CLICKHOUSE_USERNAME must be set');
  const res = await fetch(`${host}/?default_format=JSONCompact`, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': username,
      'X-ClickHouse-Key': process.env.CLICKHOUSE_PASSWORD ?? '',
    },
    body: LIVE_CSAM_SQL,
  });
  if (!res.ok) throw new Error(`clickhouse ${res.status}`);
  const body = (await res.json()) as { data: [string][] };
  return body.data.map(([hash]) => hash);
}

async function main() {
  const opts = parseArgs(process.argv);
  const replicaUrl = process.env.DATABASE_REPLICA_URL;
  if (!replicaUrl) throw new Error('DATABASE_REPLICA_URL must be set');
  const replica = new PrismaClient({ datasourceUrl: replicaUrl });
  let primary: PrismaClient | undefined;
  try {
    await run(opts, {
      readLive: readLiveFromClickhouse,
      readPg: async () =>
        (await replica.$queryRawUnsafe<{ hash: string }[]>(PG_CSAM_SQL)).map((r) => r.hash),
      readCopied: async (hashes) =>
        (
          await replica.$queryRawUnsafe<{ count: number }[]>(PG_COPIED_COUNT_SQL, hashes)
        )[0].count,
      writer: () => {
        if (!process.env.DATABASE_URL) throw new Error('--apply needs DATABASE_URL');
        primary = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
        const client = primary;
        return { execute: (sql) => client.$executeRawUnsafe(sql) };
      },
      log: (line) => console.log(line),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  } finally {
    await replica.$disconnect();
    await primary?.$disconnect();
  }
}

// Only when run as a script, so importing it for the tests runs nothing.
if (process.argv[1]?.includes(SCRIPT_BASENAME)) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
