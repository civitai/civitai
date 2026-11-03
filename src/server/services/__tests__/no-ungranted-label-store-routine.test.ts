import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 App code calls only the `label_store` routines the app's database role may execute. The
 * migrations revoke every routine from PUBLIC and grant a few back by hand, so a call to any other
 * routine compiles, passes its mocked tests, and fails in production on every call. To call a new
 * one, grant it first, then add it here.
 */
const APP_EXECUTABLE = new Set([
  'attach_bytes',
  'exclude',
  'person_hash',
  'record_label',
  'submit_predictions',
  'text_hash',
]);

const SRC = path.resolve(__dirname, '../../../../src');
const CODE_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEST_FILE = /\.test\.tsx?$|(^|\/)__tests__\//;
const ROUTINE_CALL = /label_store\.([a-z_][a-z0-9_]*)\s*\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

const routinesCalled = (source: string) => [...source.matchAll(ROUTINE_CALL)].map((m) => m[1]);

const calls = walk(SRC)
  .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
  .filter((file) => !TEST_FILE.test(file))
  .flatMap((file) =>
    routinesCalled(readFileSync(path.join(SRC, file), 'utf8')).map((routine) => ({ file, routine }))
  );

describe('🔴 app code calls only label_store routines the app role may execute', () => {
  it('the scan finds the label-store callers', () => {
    const routines = new Set(calls.map((c) => c.routine));
    expect(routines).toContain('record_label');
    expect(routines).toContain('submit_predictions');
  });

  it.each([
    ['SELECT label_store.record_prediction(', 'record_prediction'],
    ['label_store.image_excluded (${id}::int)', 'image_excluded'],
  ])('reads the routine name from %j', (source, routine) => {
    expect(routinesCalled(source)).toEqual([routine]);
  });

  it('calls no routine outside the granted set', () => {
    expect(calls.filter((c) => !APP_EXECUTABLE.has(c.routine))).toEqual([]);
  });
});
