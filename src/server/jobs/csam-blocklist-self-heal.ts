import {
  CSAM_REPORT_LISTED_IMAGE_IDS_SQL,
  CSAM_REPORT_LISTINGS_SQL,
  NEWEST_BLOCKLIST_ROW_SQL,
} from '@civitai/shared/held-media';
import { REDACT_LOG_MARKER } from '@civitai/db';
import { csamInBlockedForSql } from '@civitai/shared/csam-blocked-for';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { blocklistCall } from '~/server/services/blocked-image-hash';
import { bulkAddBlockedImages, mirrorCsamEntries } from '~/server/services/image.service';
import { BlockImageReason } from '~/shared/utils/prisma/enums';
import { createJob } from './job';

/**
 * Repairs the blocklist for images removed for CSAM that are listed on a CsamReport: adds the
 * entry of a hash that has never had a CSAM row (a write lost, or a hash that only appeared after
 * the block; the block itself would have written it over any other row), and the Postgres copy of
 * a live entry that lacks one. Never re-adds a hash whose newest row is disabled (an unblocklist),
 * and never writes over a newer row of another reason on a hash that had a CSAM row.
 * An account-wide removal's other images (`sweep`) are counted, never written.
 *
 * Writes only while the Flipt flag is on; off, unknown or unreachable, it logs counts only.
 */

const LISTED_IDS = `ARRAY(SELECT l.id::bigint FROM (${CSAM_REPORT_LISTED_IMAGE_IDS_SQL}) l WHERE l.id ~ '^[0-9]{1,18}$')`;
const CSAM_BLOCKED = `ingestion IN ('Blocked', 'Error') AND ${csamInBlockedForSql(
  '"blockedFor"'
)} AND "pHash" IS NOT NULL`;

/** With each image's earliest report, which decides whether a never-listed hash may be healed. */
export const REPORTED_CANDIDATES_SQL = `WITH listed AS (
  SELECT l.id::bigint AS id, min(l."createdAt") AS "reportedAt"
  FROM (${CSAM_REPORT_LISTINGS_SQL}) l WHERE l.id ~ '^[0-9]{1,18}$' GROUP BY 1
)
SELECT i.id, i."pHash"::text AS "pHash", listed."reportedAt" FROM "Image" i
JOIN listed ON i.id = listed.id
WHERE ${CSAM_BLOCKED}`;

/**
 * From here on both apps were serving the code that writes a Postgres copy with every CSAM entry
 * (the later of the two releases, with margin). A hash reported earlier that is neither in the
 * blocklist read nor copied may be an unblocklist a merge hid, so it is never healed.
 */
export const COPY_ERA_START = new Date('2026-11-19T01:00:00Z');
/**
 * Logged only; nothing reads it to decide a write. The exact `'CSAM'` keeps it on the partial CSAM-blocked
 * index: the comma-list test cannot use it and walks every Blocked image.
 */
export const SWEEP_COUNT_SQL = `SELECT count(*)::int AS sweep FROM "Image"
  WHERE ingestion IN ('Blocked', 'Error') AND "blockedFor" = 'CSAM' AND "pHash" IS NOT NULL
  AND NOT (id = ANY(${LISTED_IDS}))`;
/** On the primary, right before a write: the ids among $1 still removed for CSAM, with their hash. */
export const STILL_BLOCKED_SQL = `SELECT id, "pHash"::text AS "pHash" FROM "Image"
  WHERE id = ANY($1::int[]) AND ${CSAM_BLOCKED}`;
/** Takes hashes as its parameter, so it carries the marker that keeps them out of the slow-query log. */
export const PG_CSAM_AMONG_SQL = `${REDACT_LOG_MARKER} SELECT hash::text AS hash FROM "BlockedImage"
  WHERE reason = 'CSAM' AND hash = ANY($1::text[]::bigint[])`;

export const HEAL_CAP = 500;

type Row = { id: number; pHash: string };
type Candidate = Row & { reportedAt: Date };
type Newest = { hash: string; reason: string; disabled: boolean };
export type HealCounts = {
  writes: boolean;
  candidates: number;
  /** Never had a CSAM row: no row at all, or only rows of other reasons. Healed. */
  notCsamEver: number;
  /** As notCsamEver, but reported before COPY_ERA_START. Counted, never written. */
  notCsamEverPreCopy: number;
  /** Had a CSAM entry (it has a Postgres copy) that a merge replaced. Counted, never written. */
  csamMergedAway: number;
  pgGap: number;
  disabled: number;
  otherReason: number;
  sweep: number;
  healed: number;
  capped: boolean;
};

export type HealDeps = {
  readCandidates: () => Promise<Candidate[]>;
  readSweepCount: () => Promise<number>;
  readNewest: (hashes: string[]) => Promise<Newest[]>;
  readPgCsam: (hashes: string[]) => Promise<string[]>;
  rereadPrimary: (ids: number[]) => Promise<Row[]>;
  /** A CSAM entry and its Postgres copy. */
  addEntries: (hashes: string[]) => Promise<void>;
  /** The Postgres copy only. */
  copyToPg: (hashes: string[]) => Promise<void>;
  log: (counts: HealCounts) => void;
};

export async function healCsamBlocklist({ writes }: { writes: boolean }, deps: HealDeps) {
  const [rows, sweep] = await Promise.all([deps.readCandidates(), deps.readSweepCount()]);
  const idsByHash = new Map<string, number[]>();
  const firstReport = new Map<string, number>();
  for (const { id, pHash, reportedAt } of rows) {
    idsByHash.set(pHash, [...(idsByHash.get(pHash) ?? []), id]);
    const at = new Date(reportedAt).getTime();
    firstReport.set(pHash, Math.min(firstReport.get(pHash) ?? Infinity, at));
  }
  const hashes = [...idsByHash.keys()];
  const newest = new Map(
    (hashes.length ? await deps.readNewest(hashes) : []).map((row) => [row.hash, row])
  );

  const absent: string[] = [];
  const liveCsam: string[] = [];
  let disabled = 0;
  let otherReason = 0;
  for (const hash of hashes) {
    const row = newest.get(hash);
    if (!row) absent.push(hash);
    else if (row.disabled) disabled++;
    else if (row.reason === 'CSAM') liveCsam.push(hash);
    else otherReason++;
  }
  const looked = [...liveCsam, ...absent];
  const copied = new Set(looked.length ? await deps.readPgCsam(looked) : []);
  const pgGap = liveCsam.filter((hash) => !copied.has(hash));
  // Absent from the read but with a Postgres copy: it had a CSAM entry that a newer row replaced when
  // the table merged. Its newest row is unknown (it may be an unblocklist), so it is never written.
  const csamMergedAway = absent.filter((hash) => copied.has(hash)).length;
  const neverCopied = absent.filter((hash) => !copied.has(hash));
  const notCsamEver = neverCopied.filter(
    (hash) => (firstReport.get(hash) ?? 0) >= COPY_ERA_START.getTime()
  );
  const notCsamEverPreCopy = neverCopied.length - notCsamEver.length;

  const queue = [
    ...notCsamEver.map((hash) => ({ hash, copyOnly: false })),
    ...pgGap.map((hash) => ({ hash, copyOnly: true })),
  ];
  const capped = queue.length > HEAL_CAP;
  const batch = queue.slice(0, HEAL_CAP);
  let healed = 0;
  if (writes && batch.length) {
    const still = new Set(
      (await deps.rereadPrimary(batch.flatMap(({ hash }) => idsByHash.get(hash) ?? []))).map(
        (row) => row.pHash
      )
    );
    const ready = batch.filter(({ hash }) => still.has(hash));
    // Read again just before the write: an entry only where the hash still has no CSAM row (one
    // written or disabled since wins), a copy only where the entry is still live.
    const now = new Map((await deps.readNewest(ready.map((b) => b.hash))).map((r) => [r.hash, r]));
    const live = (hash: string) => {
      const row = now.get(hash);
      return !!row && row.reason === 'CSAM' && !row.disabled;
    };
    const entries = ready.filter((b) => !b.copyOnly && !now.has(b.hash)).map((b) => b.hash);
    const copies = ready.filter((b) => b.copyOnly && live(b.hash)).map((b) => b.hash);
    if (entries.length) await deps.addEntries(entries);
    if (copies.length) await deps.copyToPg(copies);
    healed = entries.length + copies.length;
  }

  const counts: HealCounts = {
    writes,
    candidates: hashes.length,
    notCsamEver: notCsamEver.length,
    notCsamEverPreCopy,
    csamMergedAway,
    pgGap: pgGap.length,
    disabled,
    otherReason,
    sweep,
    healed,
    capped,
  };
  deps.log(counts);
  return counts;
}

/**
 * The newest row of every hash that has ever had a CSAM row, from a query whose text never
 * changes: no hash value travels in the request, so none reaches a query log or a request log.
 * Hashes with no CSAM row are absent, whether they have other rows or none.
 */
export const NEWEST_ROWS_SQL = `SELECT toString(hash) AS hash, tupleElement(newest, 1) AS reason,
  tupleElement(newest, 2) AS disabled
FROM (
  SELECT hash, ${NEWEST_BLOCKLIST_ROW_SQL} AS newest FROM blocked_images
  -- Not filtered on disabled: an unblocklisted hash must stay in the set, or it reads as never listed.
  WHERE hash IN (SELECT hash FROM blocked_images WHERE reason = 'CSAM') GROUP BY hash
)`;

async function readNewest(hashes: string[]): Promise<Newest[]> {
  if (!hashes.length) return [];
  const client = clickhouse;
  if (!client) throw new Error('blocked_images: no ClickHouse client');
  const wanted = new Set(hashes);
  const rows = await blocklistCall(() =>
    client.$query<{ hash: string; reason: string; disabled: boolean | number }>(NEWEST_ROWS_SQL)
  );
  return rows
    .filter((row) => wanted.has(row.hash))
    .map((row) => ({ ...row, disabled: !!row.disabled }));
}

const deps: HealDeps = {
  readCandidates: () => dbRead.$queryRawUnsafe<Candidate[]>(REPORTED_CANDIDATES_SQL),
  readSweepCount: async () =>
    (await dbRead.$queryRawUnsafe<{ sweep: number }[]>(SWEEP_COUNT_SQL))[0]?.sweep ?? 0,
  readNewest,
  readPgCsam: async (hashes) =>
    (await dbRead.$queryRawUnsafe<{ hash: string }[]>(PG_CSAM_AMONG_SQL, hashes)).map(
      (row) => row.hash
    ),
  rereadPrimary: (ids) => dbWrite.$queryRawUnsafe<Row[]>(STILL_BLOCKED_SQL, ids),
  addEntries: (hashes) =>
    bulkAddBlockedImages({
      data: hashes.map((hash) => ({ hash: BigInt(hash), reason: BlockImageReason.CSAM })),
      context: { step: 'self-heal' },
    }),
  copyToPg: (hashes) => mirrorCsamEntries(hashes.map(BigInt), { step: 'self-heal' }),
  log: (counts) =>
    logToAxiom({
      type: 'info',
      name: 'csam-blocklist-healed',
      message: 'CSAM blocklist self-heal run',
      payload: counts,
    }),
};

export async function runCsamBlocklistSelfHeal() {
  return healCsamBlocklist(
    { writes: await isFlipt(FLIPT_FEATURE_FLAGS.CSAM_BLOCKLIST_SELF_HEAL) },
    deps
  );
}

export const csamBlocklistSelfHeal = createJob(
  'csam-blocklist-self-heal',
  '17 * * * *',
  runCsamBlocklistSelfHeal
);
