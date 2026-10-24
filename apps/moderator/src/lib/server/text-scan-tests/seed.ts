import { sql, type Kysely } from 'kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { normaliseLabFields } from '../../text-scan-lab/compose';
import {
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  type LabEntityType,
  type LabField,
} from '../../text-scan-lab/types';
import {
  parseExpected,
  scoredLabels,
  type Expected,
  type FlagLabel,
} from '../../text-scan-tests/expected';
import { TEST_SET_LIMITS, type Workspace } from '../../text-scan-tests/types';
import { TestSetError, createSet, upsertCase } from './store';
import { refreshSetTotals } from './totals';

export type TruthMap = Record<string, 'yes' | 'no' | 'skip'>;
export type SeedRow = {
  entityType: LabEntityType;
  entityId: number | null;
  authorId: number | null;
  sourceRef: string | null;
  fields: LabField[];
  expected: Expected;
  note: string | null;
};
export type SeedParse = { rows: SeedRow[]; refused: Record<string, number> };

const MAX_INT4 = 2_147_483_647;
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_INT4;
const isEntityType = (v: unknown): v is LabEntityType =>
  (LAB_ENTITY_TYPES as readonly unknown[]).includes(v);

export function parseTruthMap(raw: string): TruthMap | string {
  const map: TruthMap = Object.create(null);
  for (const pair of raw.split(',').filter((p) => p.trim())) {
    const [key, value] = pair.split('=').map((part) => part.trim());
    if (!key || (value !== 'yes' && value !== 'no' && value !== 'skip'))
      return '--truth-map values are yes, no or skip.';
    map[key] = value;
  }
  return map;
}

function fieldsOf(raw: unknown): LabField[] | null {
  if (
    !Array.isArray(raw) ||
    !raw.every(
      (f) =>
        isObject(f) &&
        typeof f.heading === 'string' &&
        (f.text == null || typeof f.text === 'string')
    )
  )
    return null;
  const fields = normaliseLabFields(raw as { heading: string; text?: string | null }[]);
  return typeof fields === 'string' || !fields.length ? null : fields;
}

function collector() {
  const rows: SeedRow[] = [];
  const refused: Record<string, number> = {};
  const seen = new Set<string>();
  return {
    rows,
    refused,
    refuse: (reason: string) => void (refused[reason] = (refused[reason] ?? 0) + 1),
    add(row: SeedRow) {
      const key =
        row.entityId !== null
          ? `e:${row.entityType}:${row.entityId}`
          : row.sourceRef !== null
          ? `r:${row.sourceRef}`
          : null;
      if (key && seen.has(key))
        return this.refuse(row.entityId !== null ? 'duplicate entity' : 'duplicate key');
      if (key) seen.add(key);
      rows.push(row);
    },
  };
}

export function parseLabSeed(json: unknown): SeedParse | string {
  if (!isObject(json) || !Array.isArray(json.cases))
    return 'A lab-seed file is an object with a cases array.';
  const out = collector();
  for (const raw of json.cases) {
    if (!isObject(raw)) {
      out.refuse('not an object');
      continue;
    }
    if (!isEntityType(raw.entityType)) {
      out.refuse('unknown entity type');
      continue;
    }
    if (raw.entityId != null && !isId(raw.entityId)) {
      out.refuse('bad id');
      continue;
    }
    if (raw.authorId !== undefined && raw.authorId !== null && !isId(raw.authorId)) {
      out.refuse('bad id');
      continue;
    }
    const fields = fieldsOf(raw.fields);
    if (!fields) {
      out.refuse('no text');
      continue;
    }
    const expected = parseExpected(raw.expected ?? {}, raw.entityType);
    if (typeof expected === 'string') {
      out.refuse('bad expectation');
      continue;
    }
    if (typeof raw.note === 'string' && raw.note.length > TEST_SET_LIMITS.noteChars) {
      out.refuse('note too long');
      continue;
    }
    out.add({
      entityType: raw.entityType,
      entityId: (raw.entityId as number | null | undefined) ?? null,
      authorId: (raw.authorId as number | null | undefined) ?? null,
      sourceRef: null,
      fields,
      expected,
      note: typeof raw.note === 'string' && raw.note ? raw.note : null,
    });
  }
  return { rows: out.rows, refused: out.refused };
}

export function parseBench(
  json: unknown,
  label: FlagLabel,
  truthMap: TruthMap
): SeedParse | string {
  if (!Array.isArray(json)) return 'A bench file is an array.';
  const out = collector();
  for (const raw of json) {
    if (!isObject(raw)) {
      out.refuse('not an object');
      continue;
    }
    if (
      typeof raw.key !== 'string' ||
      !raw.key ||
      raw.key.length > TEST_SET_LIMITS.sourceRefChars
    ) {
      out.refuse('bad key');
      continue;
    }
    if (!isEntityType(raw.entityType)) {
      out.refuse('unknown entity type');
      continue;
    }
    if (!LAB_LABELS[raw.entityType].includes(label)) {
      out.refuse('label not scored for entity type');
      continue;
    }
    if (raw.entityId != null && !isId(raw.entityId)) {
      out.refuse('bad id');
      continue;
    }
    const fields = fieldsOf(raw.fields);
    if (!fields) {
      out.refuse('no text');
      continue;
    }
    const outcome = Object.hasOwn(truthMap, String(raw.truth))
      ? truthMap[String(raw.truth)]
      : undefined;
    if (!outcome) {
      out.refuse('unmapped truth value');
      continue;
    }
    out.add({
      entityType: raw.entityType,
      entityId: (raw.entityId as number | null | undefined) ?? null,
      authorId: null,
      sourceRef: raw.key,
      fields,
      expected: outcome === 'skip' ? {} : { [label]: outcome === 'yes' },
      note: null,
    });
  }
  return { rows: out.rows, refused: out.refused };
}

export type ImportOptions = {
  set: string;
  workspace: Workspace;
  format: 'lab-seed' | 'bench';
  label?: FlagLabel;
  truthMap?: TruthMap;
  by: number;
  write: boolean;
};

export type ImportSummary = {
  rows: number;
  byEntityType: Record<string, number>;
  byLabel: Record<string, number>;
  refused: Record<string, number>;
  written: { created: number; updated: number } | null;
};

const tally = (keys: string[]) =>
  keys.reduce<Record<string, number>>((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {});

/** Validates as addCase does (upsertCase). */
export async function importSeed(
  db: Kysely<ModeratorDB> | null,
  json: unknown,
  opts: ImportOptions
): Promise<ImportSummary> {
  const parsed =
    opts.format === 'bench'
      ? opts.label && opts.truthMap
        ? parseBench(json, opts.label, opts.truthMap)
        : '--format bench needs --label and --truth-map.'
      : parseLabSeed(json);
  if (typeof parsed === 'string') throw new TestSetError(parsed, 400);
  const summary: ImportSummary = {
    rows: parsed.rows.length,
    byEntityType: tally(parsed.rows.map((r) => r.entityType)),
    byLabel: tally(parsed.rows.flatMap((r) => scoredLabels(r.expected))),
    refused: parsed.refused,
    written: null,
  };
  if (!opts.write || !db) return summary;

  const outcome = await db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('text_scan_test_set')
      .select(['id', 'workspace', 'archived_at'])
      .where('name', '=', opts.set)
      .executeTakeFirst();
    if (existing && existing.workspace !== opts.workspace)
      throw new TestSetError('That set belongs to the other workspace.', 409);
    if (existing?.archived_at) throw new TestSetError('That set is archived.', 409);
    let setId: number;
    if (existing) setId = Number(existing.id);
    else {
      try {
        setId = (
          await createSet(
            trx,
            { name: opts.set, description: null, workspace: opts.workspace },
            opts.by
          )
        ).id;
      } catch (e) {
        if (e instanceof TestSetError)
          throw new TestSetError('Could not create that set.', e.status);
        throw e;
      }
    }
    let created = 0;
    let updated = 0;
    let rescore = false;
    const refused: Record<string, number> = {};
    for (const row of parsed.rows) {
      // A failed statement aborts the transaction; the savepoint keeps one refused row from taking the rest.
      await sql`SAVEPOINT import_row`.execute(trx);
      try {
        const saved = await upsertCase(trx, { ...row, setId, origin: 'import' }, opts.by);
        if (saved.created) created++;
        else updated++;
        rescore ||= saved.rescore;
        await sql`RELEASE SAVEPOINT import_row`.execute(trx);
      } catch (e) {
        if (!(e instanceof TestSetError)) throw e;
        await sql`ROLLBACK TO SAVEPOINT import_row`.execute(trx);
        // The error message can name the set or the entity: only a fixed reason is kept.
        const reason = e.status === 409 ? 'conflicting case' : 'rejected by validation';
        refused[reason] = (refused[reason] ?? 0) + 1;
      }
    }
    return { written: { created, updated }, refused, setId, rescore };
  });
  if (outcome.rescore) await refreshSetTotals(db, outcome.setId);
  summary.written = outcome.written;
  for (const [reason, n] of Object.entries(outcome.refused))
    summary.refused[reason] = (summary.refused[reason] ?? 0) + n;
  return summary;
}
