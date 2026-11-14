import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 App code may call only these `label_store` routines. A call to any other passes mocked tests and
 * fails with permission denied in production. Ask an infra owner to grant a new routine before adding it.
 */
const APP_EXECUTABLE = new Set([
  'attach_bytes',
  'exclude',
  // Knights records why a label write failed. Granted to the Knights role with its table rights.
  'note_failure',
  'person_hash',
  'record_label',
  'submit_predictions',
  'text_hash',
]);

const ROOT = path.resolve(__dirname, '../../../..');
const SCANNED = ['src', 'apps', 'packages'];
const SKIPPED_DIRS = new Set(['node_modules', 'migrations', 'dist', 'build', 'coverage']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.svelte']);
const TEST_FILE = /\.test\.tsx?$|(^|\/)__tests__\//;
const ROUTINE_CALL = /"?label_store"?\s*\.\s*"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
const MIGRATIONS = path.join(ROOT, 'packages/civitai-db-schema/prisma/migrations');

function walk(dir: string, extensions: Set<string>, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, extensions, out);
    else if (extensions.has(path.extname(entry))) out.push(full);
  }
  return out;
}

// `INSERT INTO label_store.rule (cols)` names a table and its columns, not a routine call.
const TABLE_REFERENCE = /\b(?:into|from|join|update|table)\s+$/i;

const routinesCalled = (source: string) =>
  [...source.matchAll(ROUTINE_CALL)]
    .filter((m) => !TABLE_REFERENCE.test(source.slice(Math.max(0, m.index - 20), m.index)))
    .map((m) => m[1].toLowerCase());

const calls = SCANNED.flatMap((dir) => walk(path.join(ROOT, dir), CODE_EXTENSIONS))
  .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
  .filter((file) => !TEST_FILE.test(file))
  .flatMap((file) =>
    routinesCalled(readFileSync(path.join(ROOT, file), 'utf8')).map((routine) => ({
      file,
      routine,
    }))
  );

const definedRoutines = new Set(
  walk(MIGRATIONS, new Set(['.sql'])).flatMap((file) =>
    [
      ...readFileSync(file, 'utf8').matchAll(/FUNCTION\s+label_store\.([a-z_][a-z0-9_]*)\s*\(/gi),
    ].map((m) => m[1].toLowerCase())
  )
);

describe('🔴 app code calls only the allowlisted label_store routines', () => {
  it('the scan finds the label-store callers', () => {
    const routines = new Set(calls.map((c) => c.routine));
    expect(routines).toContain('record_label');
    expect(routines).toContain('submit_predictions');
  });

  it.each([
    ['SELECT label_store.record_prediction(', 'record_prediction'],
    ['label_store.image_excluded (${id}::int)', 'image_excluded'],
    ['"label_store"."record_prediction"(', 'record_prediction'],
    ['LABEL_STORE.RECORD_PREDICTION(', 'record_prediction'],
  ])('reads the routine name from %j', (source, routine) => {
    expect(routinesCalled(source)).toEqual([routine]);
  });

  it.each([
    'INSERT INTO label_store.rule ("question", "minHuman")',
    'SELECT * FROM label_store.label (x)',
    'UPDATE "label_store"."rule" (',
  ])('does not read a table reference as a routine call: %j', (source) => {
    expect(routinesCalled(source)).toEqual([]);
  });

  it('allowlists only routines the migrations define', () => {
    expect([...APP_EXECUTABLE].filter((name) => !definedRoutines.has(name))).toEqual([]);
  });

  it('calls no routine outside the allowlist', () => {
    expect(calls.filter((c) => !APP_EXECUTABLE.has(c.routine))).toEqual([]);
  });
});
