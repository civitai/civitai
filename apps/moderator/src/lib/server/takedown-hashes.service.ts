import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getModeratorDb } from './moderator-db';

// Retool's `FindSHA` + `LogSHA256`: a ledger of file hashes from models that were taken down, so the
// same file can be recognised if it is uploaded again. 30k rows already.
//
// Columns are `SHA256 text`, `ModelVersionId integer`, confirmed against the live table AND against
// `LogSHA256`'s `records` field in the export, which maps
// `{SHA256: i.sha256, ModelVersionId: i.modelVersionId}`.
//
// **Retool's finder selected `m.id` (the MODEL) while feeding a column named for the version.** The
// finder was the broken half — a hash belongs to a FILE, and a file hangs off a version — so this
// selects `mv.id`. Historical rows may hold model ids, which is why the lookup renders the id as a
// version without claiming the entity resolves.

export type HashCandidate = { modelVersionId: number; modelId: number; sha256: string };

/**
 * Retool's `FindSHA`: hashes of files belonging to models that were unpublished for a violation or
 * deleted. `rawScanResult -> hashes ->> SHA256` is where the scanner leaves it.
 */
/** One press worth. The candidate set is ~188k, so this records a batch and says whether more remain
 *  — Retool was unbounded, and a silent cap here would read as "the ledger is up to date". */
export const BATCH = 1000;

/** How far one press will page looking for unrecorded work before giving up and saying so. Bounded so
 *  a press cannot walk all ~188k candidates in one request. */
const PAGES_PER_PRESS = 10;

/** Cheap probe: does this page contain anything the ledger does not already hold? */
async function hasUnrecorded(page: HashCandidate[]): Promise<boolean> {
  const rows = await getModeratorDb()
    .selectFrom('ModerationSHA')
    .select('SHA256')
    .where(
      sql<string>`upper("SHA256")`,
      'in',
      page.map((c) => c.sha256.toUpperCase())
    )
    .execute();
  const known = new Set(rows.map((r) => (r.SHA256 ?? '').toUpperCase()));
  return page.some((c) => !known.has(c.sha256.toUpperCase()));
}

export async function getTakedownHashCandidates(
  limit = BATCH,
  before?: number
): Promise<HashCandidate[]> {
  const { rows } = await sql<{ modelVersionId: number; modelId: number; sha256: string }>`
    SELECT mv.id AS "modelVersionId", m.id AS "modelId",
           mf."rawScanResult" -> 'hashes' ->> 'SHA256' AS sha256
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id
    WHERE (m.status = 'UnpublishedViolation' OR m."deletedAt" IS NOT NULL)
      AND mf."rawScanResult" -> 'hashes' ->> 'SHA256' IS NOT NULL
      ${before ? sql`AND mv.id < ${before}` : sql``}
    ORDER BY mv.id DESC
    LIMIT ${limit}
  `.execute(dbRead);
  return rows;
}

/**
 * Records what is not already there. Retool re-inserted the whole result set on every press, which is
 * how a 30k-row table accumulates duplicates of the same hash; this diffs against the ledger first and
 * reports how many were new.
 */
export async function recordTakedownHashes(): Promise<{
  found: number;
  added: number;
  more: boolean;
  lastId: number;
}> {
  // WALKS. The ledger is in another database, so "not already recorded" cannot be a SQL predicate —
  // which means a single newest-first page returns the same rows every press and the second press
  // reports "nothing new" with ~187k candidates unrecorded. Each press pages backwards by
  // `modelVersionId` until it has found real work or run out.
  let cursor: number | undefined;
  let batch: HashCandidate[] = [];
  let more = false;

  for (let page = 0; page < PAGES_PER_PRESS; page++) {
    const rows = await getTakedownHashCandidates(BATCH + 1, cursor);
    more = rows.length > BATCH;
    const window = rows.slice(0, BATCH);
    if (!window.length) break;

    cursor = window[window.length - 1].modelVersionId;
    batch = window;
    // Stop on the first page that contains anything unrecorded; the dedupe below decides.
    const anyNew = await hasUnrecorded(window);
    if (anyNew || !more) break;
  }

  if (!batch.length) return { found: 0, added: 0, more: false, lastId: 0 };

  const existing = await getModeratorDb()
    .selectFrom('ModerationSHA')
    .select('SHA256')
    // upper() on BOTH sides: an exact-match IN never returns a row stored in the other case, so the
    // case-insensitive comparison below never saw it and the hash was re-inserted anyway.
    .where(
      sql<string>`upper("SHA256")`,
      'in',
      batch.map((c) => c.sha256.toUpperCase())
    )
    .execute();

  // Compared case-insensitively because the lookup is: stored hashes are not consistently cased, and an
  // exact-match probe re-inserts a hash whose ledger row happens to be in the other case.
  const known = new Set(existing.map((r) => (r.SHA256 ?? '').toUpperCase()));
  const seen = new Set<string>();
  const fresh = batch.filter((c) => {
    const key = c.sha256.toUpperCase();
    // Within the batch too: one model version carries several files, and 1000 candidate rows carry
    // ~895 distinct hashes. Deduping only against the ledger is what accumulated the duplicates this
    // function exists to stop.
    if (known.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!fresh.length) return { found: batch.length, added: 0, more, lastId: 0 };

  // `returning` so the caller can key its audit row on a real row: `recordModActivity` de-duplicates
  // on (activity, entityType, entityId), and a constant id records only the first press ever.
  const inserted = await getModeratorDb()
    .insertInto('ModerationSHA')
    .values(fresh.map((c) => ({ SHA256: c.sha256, ModelVersionId: c.modelVersionId })))
    .returning('id')
    .execute();

  return { found: batch.length, added: fresh.length, more, lastId: inserted.at(-1)?.id ?? 0 };
}

export type HashMatch = { id: number; sha256: string; modelVersionId: number | null };

/**
 * Retool's `FindMatchingHash` hardcoded a single hash, so the interactive use was ad-hoc. As an input
 * it answers the question the ledger exists for: has this file been taken down before?
 */
export async function findTakedownHash(sha256: string): Promise<HashMatch[]> {
  const value = sha256.trim();
  // Anything that is not hash-shaped would scan 30k rows to find nothing.
  if (!/^[a-fA-F0-9]{64}$/.test(value)) return [];

  const rows = await getModeratorDb()
    .selectFrom('ModerationSHA')
    .select(['id', 'SHA256', 'ModelVersionId'])
    // The column's casing is Retool's; stored hashes are not consistently cased.
    .where(sql<boolean>`upper("SHA256") = upper(${value})`)
    .limit(50)
    .execute();

  // The ledger row id, because every match shares the same hash by construction and duplicate rows
  // for one hash are exactly what this table accumulates — a composed key would collide.
  return rows.map((r) => ({
    id: r.id,
    sha256: r.SHA256 ?? value,
    modelVersionId: r.ModelVersionId,
  }));
}
