// Relative imports only: `text-scan-lab/import.ts` loads this under plain tsx, where `$lib` does not resolve.
import { InvalidExpectedError, parseExpected } from '../../text-scan-lab/expected';
import {
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  type Expected,
  type LabEntityType,
  type LabField,
} from '../../text-scan-lab/types';

/** The file `text-scan-lab/import.ts` reads:
 *  `{ cases: [{ entityType, entityId | fields, expected, synthetic?, note? }] }`. */
export type SeedCase = {
  entityType: LabEntityType;
  expected: Expected;
  synthetic: boolean;
  note: string | null;
} & ({ kind: 'entity'; entityId: number } | { kind: 'text'; fields: LabField[] });

export class SeedFileError extends Error {
  constructor(readonly problems: string[]) {
    super(`Seed file rejected:\n${problems.join('\n')}`);
    this.name = 'SeedFileError';
  }
}

const MAX_INT4 = 2_147_483_647;
/** `text_scan_test_case.note`'s CHECK. */
const MAX_NOTE = 1000;
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function parseFields(raw: unknown): LabField[] | string {
  if (!Array.isArray(raw)) return 'fields must be an array of { heading, text }.';
  const fields: LabField[] = [];
  for (const f of raw) {
    if (!isObject(f) || typeof f.heading !== 'string' || typeof f.text !== 'string')
      return 'fields must be an array of { heading, text }.';
    if (!f.text.trim()) continue;
    if (!f.heading.trim()) return 'every field with text needs a heading.';
    fields.push({ heading: f.heading.trim(), text: f.text });
  }
  return fields.length ? fields : 'fields have no text.';
}

function parseCase(raw: unknown): SeedCase | string {
  if (!isObject(raw)) return 'must be an object.';
  const entityType = raw.entityType as LabEntityType;
  if (!(LAB_ENTITY_TYPES as readonly unknown[]).includes(entityType))
    return `Unknown entity type ${String(raw.entityType)}.`;
  if (raw.synthetic !== undefined && typeof raw.synthetic !== 'boolean')
    return 'synthetic must be true or false.';
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== 'string')
    return 'note must be a string.';
  if (typeof raw.note === 'string' && raw.note.length > MAX_NOTE) return `note is over ${MAX_NOTE} characters.`;

  let expected: Expected;
  try {
    expected = parseExpected(raw.expected ?? {}, LAB_LABELS[entityType]);
  } catch (e) {
    if (e instanceof InvalidExpectedError) return e.message;
    throw e;
  }
  const common = {
    entityType,
    expected,
    synthetic: raw.synthetic ?? false,
    note: (raw.note as string | null | undefined) || null,
  } as const;

  const hasId = raw.entityId !== undefined;
  const hasFields = raw.fields !== undefined;
  if (hasId && hasFields) return 'give entityId or fields, not both.';
  if (hasId) {
    const id = raw.entityId;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > MAX_INT4)
      return `entityId ${String(id)} is not an id.`;
    return { kind: 'entity', entityId: id, ...common } as SeedCase;
  }
  if (hasFields) {
    const fields = parseFields(raw.fields);
    if (typeof fields === 'string') return fields;
    return { kind: 'text', fields, ...common } as SeedCase;
  }
  return 'needs an entityId or fields.';
}

/** Validates every case and throws `SeedFileError` listing each bad one, so a large file is fixed in one pass. */
export function parseSeedFile(json: unknown): SeedCase[] {
  if (!isObject(json) || !Array.isArray(json.cases))
    throw new SeedFileError(['The file must be an object with a cases array.']);
  if (!json.cases.length) throw new SeedFileError(['The file has no cases.']);

  const problems: string[] = [];
  const cases: SeedCase[] = [];
  const seen = new Map<string, number>();
  json.cases.forEach((raw, i) => {
    const n = i + 1;
    const parsed = parseCase(raw);
    if (typeof parsed === 'string') {
      problems.push(`case ${n} — ${parsed}`);
      return;
    }
    if (parsed.kind === 'entity') {
      // The second would overwrite the first's expectation in the set.
      const key = `${parsed.entityType} ${parsed.entityId}`;
      const first = seen.get(key);
      if (first) {
        problems.push(`case ${n} — ${key} is already case ${first}.`);
        return;
      }
      seen.set(key, n);
    }
    cases.push(parsed);
  });
  if (problems.length) throw new SeedFileError(problems);
  return cases;
}
