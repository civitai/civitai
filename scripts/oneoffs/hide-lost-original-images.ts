/**
 * One-off: hide images whose original bytes are gone from storage, by setting
 * `ingestion = 'NotFound'`. Public reads drop the row (`imageReviewedSql`), a moderator still loads
 * it by id, the row is kept and the owner is not told. The id list is a file kept off-repo; this
 * file holds no ids.
 *
 * Held or in-review rows are skipped, the check is repeated inside the UPDATE, and only a fresh
 * HEAD 404 hides. Every row about to change is appended to `--log` (id and prior ingestion) before
 * the UPDATE; `--undo` restores from it. Output is counts only.
 *
 * Usage (dry run is the default):
 *   npm run tsscript scripts/oneoffs/hide-lost-original-images.ts --ids <file> --log <file>
 *   ... --apply --limit 1       # one id first, then read it back
 *   ... --apply                 # the rest
 *   ... --undo --log <file> --apply
 *
 * Options:
 *   --ids <file>              Image ids, one per line.
 *   --log <file>              Run log (append-only JSON lines). Off-repo.
 *   --apply                   Write. Without it nothing is written (--rebust is the exception: it
 *                             writes search and caches only).
 *   --limit <n>               Hide at most n rows this run.
 *   --chunk <n>               Ids per step, 1-500 (default 200).
 *   --concurrency <n>         HEADs in flight, 1-20 (default 10).
 *   --pause-ms <n>            Pause between chunks (default 1000).
 *   --rebust hide|undo        Catch search and caches up for the log's rows (after a stop that
 *                             said "run --rebust"). Writes search and caches, not Image.
 *   --include-unconfirmed     Undo and rebust also act on log rows never confirmed hidden.
 *   --cross-check-rerun       Required to --apply after CROSS_CHECK_EXPIRES: the Moderation Lead's
 *                             full cross-check was re-run first.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Prisma } from '@prisma/client';
import pLimit from 'p-limit';
import { hasScanWorkflowSql } from '~/server/common/judge-rating';
import { captureImageHeldSql, ownerHeldSql } from '~/server/services/legal-hold.service';

export const SCRIPT_BASENAME = 'hide-lost-original-images';
/** The Moderation Lead's cross-check is a snapshot; past this it is re-run before a write. */
export const CROSS_CHECK_EXPIRES = Date.parse('2026-11-17T07:12:00Z');
const MAX_CHUNK = 500;
const MAX_INT = 2_147_483_647;

export type RunOptions = {
  apply: boolean;
  undo: boolean;
  idsFile: string | null;
  logFile: string | null;
  limit: number;
  chunk: number;
  concurrency: number;
  pauseMs: number;
  crossCheckRerun: boolean;
  /** Undo and rebust also act on rows only intended, never confirmed hidden. */
  includeUnconfirmed: boolean;
  /** Catch search and caches up for the log's rows; writes nothing to Image. */
  rebust: 'hide' | 'undo' | null;
};

export function parseArgs(argv: string[]): RunOptions {
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const raw = argv[i + 1];
    if (raw === undefined || raw.startsWith('--')) throw new Error(`--${name} needs a value`);
    return raw;
  };
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`--${name} must be ${min}-${max}, got ${raw}`);
    return n;
  };
  const options: RunOptions = {
    apply: argv.includes('--apply'),
    undo: argv.includes('--undo'),
    idsFile: value('ids') ?? null,
    logFile: value('log') ?? null,
    limit: int('limit', Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER),
    chunk: int('chunk', 200, 1, MAX_CHUNK),
    concurrency: int('concurrency', 10, 1, 20),
    pauseMs: int('pause-ms', 1000, 0, 600_000),
    crossCheckRerun: argv.includes('--cross-check-rerun'),
    rebust: null,
    includeUnconfirmed: argv.includes('--include-unconfirmed'),
  };
  const rebustArg = value('rebust');
  if (rebustArg !== undefined) {
    if (rebustArg !== 'hide' && rebustArg !== 'undo') throw new Error('--rebust is hide or undo');
    options.rebust = rebustArg;
  }
  if (!options.logFile) throw new Error('--log is required');
  if (!options.undo && !options.rebust && !options.idsFile) throw new Error('--ids is required');
  return options;
}

/**
 * Why a row is held or in review, or NULL. Over `"Image" i`. A hold predicate that comes back NULL
 * counts as held (COALESCE ... TRUE): the CASE would otherwise fall through to "may hide".
 * A pending item in a collection is held too: collection-ai-review rejects an item whose image is
 * NotFound, which would tell the owner and which undo does not reverse.
 */
const holdReasonSql = Prisma.sql`(CASE
  WHEN i."needsReview" IS NOT NULL THEN 'needs-review'
  WHEN i."blockedFor" IS NOT NULL THEN 'blocked-for'
  WHEN i."tosViolation" THEN 'tos'
  WHEN i.minor THEN 'minor'
  WHEN i.poi THEN 'poi'
  WHEN COALESCE(${captureImageHeldSql('i')}, TRUE) THEN 'image-hold'
  WHEN COALESCE(${ownerHeldSql(Prisma.sql`i."userId"`)}, TRUE) THEN 'owner-hold'
  WHEN EXISTS (
    SELECT 1 FROM "CollectionItem" ci WHERE ci."imageId" = i.id AND ci.status = 'REVIEW'
  ) THEN 'pending-collection-item'
  -- A crucible is listed only while its cover is Scanned; hiding the cover hides the contest.
  WHEN EXISTS (
    SELECT 1 FROM "Crucible" cr WHERE cr."imageId" = i.id OR cr."heroImageId" = i.id
  ) OR EXISTS (SELECT 1 FROM "CrucibleEntry" ce WHERE ce."imageId" = i.id)
  THEN 'crucible-image'
END)`;

/** Why a row is left alone, or NULL when it may be hidden. Over `"Image" i`. */
export const skipReasonSql = Prisma.sql`(CASE
  WHEN i.ingestion <> 'Scanned'::"ImageIngestionStatus" THEN 'not-scanned'
  ELSE ${holdReasonSql}
END)`;

export function selectSql(ids: number[]) {
  return Prisma.sql`
    SELECT i.id, i.url, i."postId", i.ingestion::text AS prior, ${skipReasonSql} AS skip
    FROM "Image" i
    WHERE i.id = ANY(${ids}::int[])
  `;
}

export function hideSql(ids: number[]) {
  return Prisma.sql`
    UPDATE "Image" i
    SET ingestion = 'NotFound'::"ImageIngestionStatus"
    WHERE i.id = ANY(${ids}::int[]) AND ${skipReasonSql} IS NULL
    RETURNING i.id, i."postId"
  `;
}

export function undoSql(ids: number[], prior: string) {
  return Prisma.sql`
    UPDATE "Image" i
    SET ingestion = ${prior}::"ImageIngestionStatus"
    WHERE i.id = ANY(${ids}::int[]) AND i.ingestion = 'NotFound'::"ImageIngestionStatus"
      AND ${holdReasonSql} IS NULL
    RETURNING i.id, i."postId"
  `;
}

/** Rows of the log that still carry the state a propagation is owed for. */
export function owedSql(ids: number[], state: string) {
  return Prisma.sql`
    SELECT i.id, i."postId" FROM "Image" i
    WHERE i.id = ANY(${ids}::int[]) AND i.ingestion = ${state}::"ImageIngestionStatus"
  `;
}

/** How many of the ids have a scan that may still be in flight, by each of the two signals. */
export function inFlightSql(ids: number[]) {
  const requested = Prisma.sql`(i."scanRequestedAt" IS NOT NULL
    AND (i."scannedAt" IS NULL OR i."scanRequestedAt" > i."scannedAt"))`;
  return Prisma.sql`
    SELECT
      count(*) FILTER (WHERE ${hasScanWorkflowSql('i')})::int AS workflow,
      count(*) FILTER (WHERE ${requested})::int AS requested,
      count(*) FILTER (WHERE ${hasScanWorkflowSql('i')} AND ${requested})::int AS both
    FROM "Image" i WHERE i.id = ANY(${ids}::int[])
  `;
}

/**
 * Live images near the targets in id order, one per quantile of the target list, so the control
 * covers the same era as the keys it vouches for. A bucket that answers for recent keys proves
 * nothing for 2024 ones.
 */
export function controlSql(targets: number[]) {
  const picks = [0, 0.25, 0.5, 0.75, 1].map((q) => targets[Math.floor(q * (targets.length - 1))]);
  return Prisma.sql`
    SELECT (
      SELECT i.url FROM "Image" i
      WHERE i.id >= q AND i.ingestion = 'Scanned'::"ImageIngestionStatus"
        AND i.id <> ALL(${targets}::int[])
      ORDER BY i.id LIMIT 1
    ) AS url
    FROM unnest(${picks}::int[]) AS q
  `;
}

/** `hidden` marks a row the UPDATE returned; a line without it is only the intent to hide. */
export type LogEntry = { id: number; prior: string; hidden?: true };

export type HeadResult = 'present' | 'missing';
export type Touched = { id: number; postId: number | null };

export type Deps = {
  query: <T>(sql: Prisma.Sql) => Promise<T[]>;
  /** 'missing' only for a 404; throws on anything else. */
  head: (url: string) => Promise<HeadResult>;
  /** An external url, not a key in our storage: cannot be HEADed. */
  isExternal: (url: string) => boolean;
  /** Search-index Delete (hide) or Update (undo), existence cache, post caches. */
  propagate: (touched: Touched[], action: 'hide' | 'undo') => Promise<void>;
  appendLog: (entries: LogEntry[]) => void;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => number;
};

type Counts = Record<string, number>;
const bump = (counts: Counts, key: string, by = 1) => (counts[key] = (counts[key] ?? 0) + by);

/**
 * The rows are already changed when this runs, and a re-run skips them as not-scanned, so a failure
 * here is never retried by the main path: stop and say how to catch the caches up (`--rebust`).
 */
async function propagateOrStop(touched: Touched[], action: 'hide' | 'undo', deps: Deps) {
  try {
    await deps.propagate(touched, action);
  } catch (e) {
    deps.log(
      `stopped: ${touched.length} rows changed but search/caches not updated; run --rebust ${action}`
    );
    throw e;
  }
}

/** Catches search and caches up for log rows still in the state a hide (or an undo) left them in. */
export async function rebust(
  entries: { id: number; prior: string }[],
  action: 'hide' | 'undo',
  options: RunOptions,
  deps: Deps
) {
  const groups = new Map<string, number[]>();
  for (const e of entries) {
    const state = action === 'hide' ? 'NotFound' : e.prior;
    const ids = groups.get(state) ?? [];
    ids.push(e.id);
    groups.set(state, ids);
  }
  let n = 0;
  for (const [state, all] of groups)
    for (let i = 0; i < all.length; i += options.chunk) {
      const owed = await deps.query<Touched>(owedSql(all.slice(i, i + options.chunk), state));
      if (owed.length) await deps.propagate(owed, action);
      n += owed.length;
    }
  deps.log(`rebust ${action}: ${n} rows`);
  return n;
}

/** A sample of live images must all HEAD present; otherwise a 404 means nothing. */
export async function controlOk(ids: number[], deps: Pick<Deps, 'query' | 'head' | 'isExternal'>) {
  const rows = await deps.query<{ url: string | null }>(controlSql(ids));
  // One checkable image per quantile pick, or the control no longer covers the era it vouches for.
  const checkable = rows.filter((r): r is { url: string } => !!r.url && !deps.isExternal(r.url));
  if (!rows.length || checkable.length !== rows.length) return 0;
  const results = await Promise.all(checkable.map((r) => deps.head(r.url).catch(() => 'error')));
  return results.every((r) => r === 'present') ? checkable.length : 0;
}

export async function run(options: RunOptions, ids: number[], deps: Deps) {
  if (options.apply && deps.now() > CROSS_CHECK_EXPIRES && !options.crossCheckRerun)
    throw new Error(
      'the Moderation Lead cross-check has expired: re-run it, then pass --cross-check-rerun'
    );
  const controls = await controlOk(ids, deps);
  if (!controls)
    throw new Error(
      'control failed: not every quantile has a live image that HEADs present; no HEAD is trusted'
    );

  const counts: Counts = { listed: ids.length, controls };
  const [flight] = await deps.query<{ workflow: number; requested: number; both: number }>(
    inFlightSql(ids)
  );
  counts['scan-in-flight:workflow-present'] = flight.workflow;
  counts['scan-in-flight:requested-after-scanned'] = flight.requested;
  counts['scan-in-flight:both'] = flight.both;
  let hidden = 0;
  const seen = new Set<number>();
  for (let i = 0; i < ids.length && hidden < options.limit; i += options.chunk) {
    const chunk = ids.slice(i, i + options.chunk);
    const rows = await deps.query<{
      id: number;
      url: string;
      postId: number | null;
      prior: string;
      skip: string | null;
    }>(selectSql(chunk));
    for (const r of rows) seen.add(r.id);
    const eligible = rows.filter((r) => {
      if (r.skip) bump(counts, `skipped:${r.skip}`);
      else if (deps.isExternal(r.url)) bump(counts, 'skipped:external-url');
      else return true;
      return false;
    });

    const limit = pLimit(options.concurrency);
    const heads = await Promise.all(
      eligible.map((r) =>
        limit(async () => {
          try {
            return await deps.head(r.url);
          } catch {
            return 'error' as const;
          }
        })
      )
    );
    const gone = eligible.filter((_, n) => {
      if (heads[n] === 'missing') return true;
      bump(counts, heads[n] === 'present' ? 'skipped:now-200' : 'skipped:head-error');
      return false;
    });
    bump(counts, 'still-404', gone.length);

    const room = options.limit - hidden;
    const batch = gone.slice(0, room);
    if (options.apply && batch.length) {
      deps.appendLog(batch.map((r) => ({ id: r.id, prior: r.prior })));
      const touched = await deps.query<Touched>(hideSql(batch.map((r) => r.id)));
      const prior = new Map(batch.map((r) => [r.id, r.prior]));
      if (touched.length)
        deps.appendLog(
          touched.map((t) => ({ id: t.id, prior: prior.get(t.id) as string, hidden: true }))
        );
      bump(counts, 'raced-out', batch.length - touched.length);
      hidden += touched.length;
      if (touched.length) await propagateOrStop(touched, 'hide', deps);
    } else hidden += batch.length;
    if (i + options.chunk < ids.length) await deps.sleep(options.pauseMs);
  }
  counts['no-row'] = ids.filter((id) => !seen.has(id)).length;
  counts[options.apply ? 'hidden' : 'would-hide'] = hidden;
  for (const [k, v] of Object.entries(counts)) deps.log(`${k}: ${v}`);
  return counts;
}

export async function undo(
  entries: { id: number; prior: string }[],
  options: RunOptions,
  deps: Deps
) {
  const byPrior = new Map<string, number[]>();
  for (const e of entries) {
    const ids = byPrior.get(e.prior) ?? [];
    ids.push(e.id);
    byPrior.set(e.prior, ids);
  }
  let restored = 0;
  for (const [prior, all] of byPrior)
    for (let i = 0; i < all.length; i += options.chunk) {
      const chunk = all.slice(i, i + options.chunk);
      if (!options.apply) continue;
      const touched = await deps.query<Touched>(undoSql(chunk, prior));
      restored += touched.length;
      if (touched.length) await propagateOrStop(touched, 'undo', deps);
    }
  if (options.apply)
    deps.log(
      `restored: ${restored}; not restored (no longer NotFound, or held since): ${
        entries.length - restored
      }`
    );
  else deps.log(`would try to restore: ${entries.length}`);
  return restored;
}

/**
 * The rows undo and rebust may touch: those an UPDATE returned. A row that was only intended (the
 * UPDATE refused it, or the run died before the confirmation line) is left alone unless asked for,
 * because it may have gone NotFound by itself.
 */
export function actedOn(entries: LogEntry[], includeUnconfirmed: boolean) {
  const confirmed = new Set(entries.filter((e) => e.hidden).map((e) => e.id));
  const seen = new Set<number>();
  return entries.filter((e) => {
    if (seen.has(e.id) || !(includeUnconfirmed || confirmed.has(e.id))) return false;
    seen.add(e.id);
    return true;
  });
}

/**
 * Appends and fsyncs: a hide that outlives its log line cannot be told from an organic NotFound.
 * A torn tail (a crash mid-write) is cut off first: its UPDATE never ran, and left in place it
 * would swallow or poison the lines appended after it.
 */
export function appendDurable(file: string, text: string) {
  if (fs.existsSync(file)) {
    const body = fs.readFileSync(file, 'utf8');
    if (body && !body.endsWith('\n')) fs.truncateSync(file, body.lastIndexOf('\n') + 1);
  }
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** A torn last line (a crash mid-write) is dropped; a bad line anywhere else is an error. */
export function readLog(file: string): LogEntry[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.flatMap((l, n) => {
    try {
      return [JSON.parse(l) as LogEntry];
    } catch (e) {
      if (n === lines.length - 1) return [];
      throw e;
    }
  });
}

export function readIds(file: string) {
  const ids = [
    ...new Set(
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          if (!/^\d{1,10}$/.test(l) || Number(l) > MAX_INT)
            throw new Error('ids file has a line that is not an id');
          return Number(l);
        })
    ),
  ];
  return ids.sort((a, b) => a - b);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Prisma query logging would print the id arrays this script sends.
  if (/prisma/.test(process.env.LOGGING ?? ''))
    throw new Error('unset LOGGING (prisma query logging prints the target ids)');
  const { dbWrite } = await import('~/server/db/client');
  const { getImageUploadBackend, headObject } = await import('~/utils/s3-utils');
  const { isEdgeUrlPassthrough } = await import('~/shared/utils/edge-url-passthrough');
  const { SearchIndexUpdateQueueAction } = await import('~/server/common/enums');
  const { queueImageSearchIndexUpdate, invalidateManyImageExistence } = await import(
    '~/server/services/image.service'
  );
  const { bustCachesForPosts } = await import('~/server/services/post.service');

  const backend = await getImageUploadBackend();
  const logFile = options.logFile as string;
  const deps: Deps = {
    query: <T>(sql: Prisma.Sql) => dbWrite.$queryRaw<T[]>(sql),
    // headObject answers absent only for a 404; anything else is unknown, which fails closed here.
    head: async (url) => {
      const head = await headObject(backend.bucket, url, backend.s3, {
        abortSignal: AbortSignal.timeout(10_000),
      });
      if (head.status === 'unknown') throw new Error('HEAD could not be answered');
      return head.status === 'absent' ? 'missing' : 'present';
    },
    isExternal: (url) => isEdgeUrlPassthrough(url),
    propagate: async (touched, action) => {
      const ids = touched.map((t) => t.id);
      await queueImageSearchIndexUpdate({
        ids,
        action:
          action === 'hide'
            ? SearchIndexUpdateQueueAction.Delete
            : SearchIndexUpdateQueueAction.Update,
      });
      // Hide only: this writes 'false' for 5 minutes, which would hide a restored row from the feed.
      if (action === 'hide') await invalidateManyImageExistence(ids);
      const postIds = [
        ...new Set(touched.map((t) => t.postId).filter((p): p is number => p != null)),
      ];
      if (postIds.length) await bustCachesForPosts(postIds);
    },
    appendLog: (entries) =>
      appendDurable(logFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n'),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
    now: () => Date.now(),
  };

  const acted = () => actedOn(readLog(logFile), options.includeUnconfirmed);
  if (options.rebust) await rebust(acted(), options.rebust, options, deps);
  else if (options.undo) await undo(acted(), options, deps);
  else await run(options, readIds(options.idsFile as string), deps);
  if (!options.apply && !options.rebust)
    deps.log('dry run: nothing written (pass --apply to write)');
  if (fs.existsSync(logFile))
    deps.log(`log sha256: ${createHash('sha256').update(fs.readFileSync(logFile)).digest('hex')}`);
}

// Only when run as a script: importing the builders above must not start a run.
if (process.argv[1]?.includes(SCRIPT_BASENAME)) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
