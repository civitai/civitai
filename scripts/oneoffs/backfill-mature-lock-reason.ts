/**
 * One-off: give nsfw locks the save-time text filter set before it recorded its attribution the
 * `fields` / `category` / `textHash` a new lock carries, so their owners see which field set the lock
 * off. Only where the text is unchanged since the lock; every other lock keeps the plain message. New
 * locks carry the hash, so nothing needs this after it has run.
 *
 * Usage:
 *   pnpm run tsscript scripts/oneoffs/backfill-mature-lock-reason.ts           dry run: counts only
 *   pnpm run tsscript scripts/oneoffs/backfill-mature-lock-reason.ts --write   writes `writable`
 *
 * Output is counts only: no model ids, no text, no filter output. A write re-checks the row as read
 * (`updatedAt`, `name`, `description`, the lock's `at`, still unattributed), so `written` below
 * `writable` means rows moved during the run; those are left alone.
 *
 * A lock is attributed only when all of these hold:
 *   - `updatedAt` pins the save that set the lock. The bound depends on which path set it, told apart
 *     by how `at` was written:
 *       - Blurb fan-out (`writeAutoNsfw`): `at` and `updatedAt` are the one statement's `now()`. `at`
 *         is a timestamptz in jsonb (microseconds, numeric offset), which JS parses truncated to the
 *         millisecond; `updatedAt` is timestamp(3), which rounds. So `at <= updatedAt <= at + 1 ms`.
 *         A held lock applied when a model leaves Private writes the same stamp with no `updatedAt`,
 *         which then predates it: the lower bound excludes those.
 *       - Interactive upsert: `at` is a JS ISO string ending in `Z`, stamped before the transaction
 *         whose write sets `updatedAt`, so only `updatedAt = at` pins it. Few such locks meet it.
 *   - No blurb reference: the fan-out rewrites a referencing description without moving
 *     `updatedAt`, so `updatedAt` proves nothing for such a model.
 *   - Today's filter on the current text reproduces the detection stored with the lock (matches
 *     and metrics). Nothing overwrites that detection while the model is locked, so this also
 *     catches a text change the two checks above miss, and a filter that changed since.
 */
import { PrismaClient } from '@prisma/client';
import { isEqual } from 'lodash-es';
import { evaluateAutoNsfw } from '~/server/services/auto-nsfw';

export const SCRIPT_BASENAME = 'backfill-mature-lock-reason';
const BATCH = 1000;

export type Candidate = {
  id: number;
  name: string | null;
  description: string | null;
  updatedAt: Date;
  blurbLinked?: boolean;
  meta: {
    systemNsfwLock?: { source?: string; at?: string };
    profanityMatches?: string[];
    profanityEvaluation?: { metrics?: unknown };
  } | null;
};

/** Whether `updatedAt` is the save that set the lock stamped `at`; see the header for the bounds. */
export function updatedAtPinsLock(at: string, updatedAt: Date) {
  const lockedAt = new Date(at).getTime();
  if (Number.isNaN(lockedAt)) return false;
  const slack = at.endsWith('Z') ? 0 : 1;
  const saved = updatedAt.getTime();
  return saved >= lockedAt && saved <= lockedAt + slack;
}

/** Whether today's filter, on the current text, reproduces the detection stored with the lock. */
function sameDetection(stored: Candidate['meta'], now: ReturnType<typeof evaluateAutoNsfw>) {
  if (!now || !stored?.profanityMatches || !stored.profanityEvaluation) return false;
  const sorted = (words: string[]) => [...words].sort();
  return (
    isEqual(sorted(now.metaPatch.profanityMatches ?? []), sorted(stored.profanityMatches)) &&
    isEqual(now.metaPatch.profanityEvaluation.metrics, stored.profanityEvaluation.metrics)
  );
}

export function classify(row: Candidate) {
  const at = row.meta?.systemNsfwLock?.at;
  const pinned = !!at && !row.blurbLinked && updatedAtPinsLock(at, row.updatedAt);
  const now = evaluateAutoNsfw({
    name: row.name,
    description: row.description,
    alreadyNsfw: false,
    lockedProperties: [],
  });
  const same = sameDetection(row.meta, now);
  const attribution = pinned && same && now?.attribution.fields.length ? now.attribution : null;
  return { pinned, sameDetection: same, attribution };
}

type Db = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export async function run(db: Db, { write }: { write: boolean }) {
  const counts = {
    candidates: 0,
    updatedAtPinsLock: 0,
    sameDetectionToday: 0,
    writable: 0,
    written: 0,
    nsfwLockedWithStoredDetectionNoMarker: 0,
    ofThoseNoDetectionToday: 0,
  };

  // Filter-set nsfw locks without the attribution.
  for (let after = 0; ; ) {
    const rows = await db.$queryRaw<Candidate[]>`
      SELECT m.id, m.name, m.description, m."updatedAt", m.meta,
        EXISTS (SELECT 1 FROM "BlurbReference" br
          WHERE br."entityType" = 'Model' AND br."entityId" = m.id) AS "blurbLinked"
      FROM "Model" m
      WHERE m.id > ${after} AND m.nsfw AND 'nsfw' = ANY(m."lockedProperties")
        AND m.meta -> 'systemNsfwLock' ->> 'source' = 'profanity-filter'
        AND NOT (m.meta -> 'systemNsfwLock' ? 'textHash')
      ORDER BY m.id LIMIT ${BATCH}`;
    if (!rows.length) break;
    after = rows[rows.length - 1].id;

    for (const row of rows) {
      const { pinned, sameDetection, attribution } = classify(row);
      counts.candidates++;
      if (pinned) counts.updatedAtPinsLock++;
      if (sameDetection) counts.sameDetectionToday++;
      if (!attribution) continue;
      counts.writable++;
      if (!write) continue;
      // Epoch milliseconds, so the comparison does not depend on the session time zone.
      counts.written += await db.$executeRaw`
        UPDATE "Model"
        SET meta = jsonb_set(meta, '{systemNsfwLock}',
          (meta -> 'systemNsfwLock') || ${JSON.stringify(attribution)}::jsonb)
        WHERE id = ${row.id}
          AND round(extract(epoch FROM "updatedAt") * 1000) = ${row.updatedAt.getTime()}
          AND name IS NOT DISTINCT FROM ${row.name}
          AND description IS NOT DISTINCT FROM ${row.description}
          AND nsfw AND 'nsfw' = ANY("lockedProperties")
          AND meta -> 'systemNsfwLock' ->> 'at' = ${row.meta?.systemNsfwLock?.at}
          AND NOT (meta -> 'systemNsfwLock' ? 'textHash')`;
    }
  }

  // Count only.
  for (let after = 0; ; ) {
    const rows = await db.$queryRaw<Candidate[]>`
      SELECT id, name, description, "updatedAt", meta FROM "Model"
      WHERE id > ${after} AND nsfw AND 'nsfw' = ANY("lockedProperties")
        AND jsonb_typeof(meta -> 'profanityMatches') = 'array'
        AND jsonb_array_length(meta -> 'profanityMatches') > 0
        AND NOT (meta ? 'systemNsfwLock')
      ORDER BY id LIMIT ${BATCH}`;
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    for (const row of rows) {
      counts.nsfwLockedWithStoredDetectionNoMarker++;
      const now = evaluateAutoNsfw({
        name: row.name,
        description: row.description,
        alreadyNsfw: false,
        lockedProperties: [],
      });
      if (!now) counts.ofThoseNoDetectionToday++;
    }
  }

  return counts;
}

async function main() {
  const write = process.argv.includes('--write');
  const db = new PrismaClient();
  try {
    console.log(
      JSON.stringify({ mode: write ? 'write' : 'dry-run', ...(await run(db, { write })) })
    );
  } finally {
    await db.$disconnect();
  }
}

// Only when run as a script: importing `run` and `classify` for the test must not start a run.
if (process.argv[1]?.includes(SCRIPT_BASENAME)) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
  );
}
