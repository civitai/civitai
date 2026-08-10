import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getModeratorDb } from './moderator-db';

// Retool's `FindSHA` + `LogSHA256`: a ledger of file hashes from models that were taken down, so the
// same file can be recognised if it is uploaded again. 30k rows already.
//
// The export could not tell us the ledger's shape — `LogSHA256` is a GUI-mode BULK_INSERT whose
// changeset is empty in the export, the same gap the Front Page Audit rating logs hit. The columns
// come from the live table instead: `SHA256 text`, `ModelVersionId integer`.
//
// **Retool's finder selected `m.id` (the MODEL) while the ledger column is `ModelVersionId`.** One of
// the two is wrong and the export cannot say which, so this follows the column: a hash belongs to a
// FILE, and a file hangs off a version, not off a model. Worth checking against the existing rows
// before anything depends on them.

export type HashCandidate = { modelVersionId: number; modelId: number; sha256: string };

/**
 * Retool's `FindSHA`: hashes of files belonging to models that were unpublished for a violation or
 * deleted. `rawScanResult -> hashes ->> SHA256` is where the scanner leaves it.
 */
export async function getTakedownHashCandidates(limit = 1000): Promise<HashCandidate[]> {
  const { rows } = await sql<{ modelVersionId: number; modelId: number; sha256: string }>`
    SELECT mv.id AS "modelVersionId", m.id AS "modelId",
           mf."rawScanResult" -> 'hashes' ->> 'SHA256' AS sha256
    FROM "Model" m
    JOIN "ModelVersion" mv ON mv."modelId" = m.id
    JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id
    WHERE (m.status = 'UnpublishedViolation' OR m."deletedAt" IS NOT NULL)
      AND mf."rawScanResult" -> 'hashes' ->> 'SHA256' IS NOT NULL
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
export async function recordTakedownHashes(): Promise<{ found: number; added: number }> {
  const candidates = await getTakedownHashCandidates();
  if (!candidates.length) return { found: 0, added: 0 };

  const existing = await getModeratorDb()
    .selectFrom('ModerationSHA')
    .select('SHA256')
    .where(
      'SHA256',
      'in',
      candidates.map((c) => c.sha256)
    )
    .execute();

  const known = new Set(existing.map((r) => r.SHA256));
  const fresh = candidates.filter((c) => !known.has(c.sha256));
  if (!fresh.length) return { found: candidates.length, added: 0 };

  await getModeratorDb()
    .insertInto('ModerationSHA')
    .values(fresh.map((c) => ({ SHA256: c.sha256, ModelVersionId: c.modelVersionId })))
    .execute();

  return { found: candidates.length, added: fresh.length };
}

export type HashMatch = { sha256: string; modelVersionId: number | null };

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
    .select(['SHA256', 'ModelVersionId'])
    // The column's casing is Retool's; stored hashes are not consistently cased.
    .where(sql<boolean>`upper("SHA256") = upper(${value})`)
    .limit(50)
    .execute();

  return rows.map((r) => ({ sha256: r.SHA256 ?? value, modelVersionId: r.ModelVersionId }));
}
