import type { Kysely } from 'kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type { LabIntentListing } from '../text-scan-lab/harness-client';
import type { Expected } from '../../text-scan-tests/expected';
import { INTENT_LABEL, isIntentEvalSet } from '../../text-scan-tests/intent-set';
import { TEST_SET_LIMITS } from '../../text-scan-tests/types';
import { TestSetError, requireOpenSet, upsertCase } from './store';

export type IntentRow = { modelId: number; expected: Expected };

const VERDICTS: Record<string, Expected> = {
  detected: { [INTENT_LABEL]: true },
  clear: { [INTENT_LABEL]: false },
  // Reported, not graded.
  unsure: {},
};

/**
 * One model per line: `<model id> detected|clear|unsure`. Blank lines and `#` comments are skipped.
 * A malformed line or a repeated model refuses the whole paste, so nothing is half imported.
 */
export function parseIntentRows(raw: string): IntentRow[] | string {
  const rows: IntentRow[] = [];
  const seen = new Set<number>();
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    const text = line.replace(/#.*/, '').trim();
    if (!text) continue;
    const match = /^(\d+)[\s,]+(detected|clear|unsure)$/i.exec(text);
    const modelId = match ? Number(match[1]) : NaN;
    if (!match || !Number.isSafeInteger(modelId) || modelId < 1 || modelId > 2_147_483_647)
      return `Line ${i + 1}: write a model id and detected, clear or unsure.`;
    if (seen.has(modelId)) return `Line ${i + 1}: model ${modelId} is listed twice.`;
    seen.add(modelId);
    rows.push({ modelId, expected: VERDICTS[match[2].toLowerCase()] });
  }
  if (!rows.length) return 'List at least one model.';
  if (rows.length > TEST_SET_LIMITS.casesPerRun)
    return `At most ${TEST_SET_LIMITS.casesPerRun} models at a time.`;
  return rows;
}

export type IntentImportSummary = { created: number; updated: number; notFound: number[] };

/** `compose` is the main app's `comFaceIntentFields`, never the Model profile's text. */
export async function importIntentCases(
  deps: { db: Kysely<ModeratorDB>; compose: (ids: number[]) => Promise<LabIntentListing[]> },
  setId: number,
  rows: readonly IntentRow[],
  userId: number
): Promise<IntentImportSummary> {
  if (!isIntentEvalSet(setId))
    throw new TestSetError('Only the intent set imports models by id.', 409);
  await requireOpenSet(deps.db, setId, 'prompts');
  const listings = new Map(
    (await deps.compose(rows.map((r) => r.modelId))).map((l) => [l.entityId, l] as const)
  );
  const notFound = rows.flatMap((r) => (listings.get(r.modelId)?.ok ? [] : [r.modelId]));
  if (notFound.length === rows.length) return { created: 0, updated: 0, notFound };

  return deps.db.transaction().execute(async (trx) => {
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const listing = listings.get(row.modelId);
      if (!listing?.ok) continue;
      const saved = await upsertCase(
        trx,
        {
          setId,
          entityType: 'Model',
          entityId: row.modelId,
          authorId: listing.userId,
          sourceRef: null,
          fields: listing.fields,
          expected: row.expected,
          note: null,
          origin: 'import',
        },
        userId
      );
      if (saved.created) created++;
      else updated++;
    }
    return { created, updated, notFound };
  });
}
