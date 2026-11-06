import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 Never merge into `meta` with `COALESCE(meta, '{}') || x`.
 *
 * COALESCE only replaces SQL NULL. A stored JSON `null` survives it, and `'null'::jsonb || object`
 * concatenates into the array `[null, {...}]` — which is what broke prepare-leaderboard on
 * 2026-10-18. Write the merge through `asJsonbObject` / `asJsonbObjectSql`
 * (src/server/utils/jsonb-object.ts), which also covers JSON null.
 *
 * The admin/temp endpoint below is a one-off backfill that predates the rule; the last test fails
 * when an entry stops matching, so the list only shrinks.
 */

const SRC = path.resolve(__dirname, '../../../../src');
const CODE_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEST_FILE = /\.test\.tsx?$|(^|\/)__tests__\//;

const COALESCE_META_CONCAT = /COALESCE\(\s*"?\w*\.?meta"?\s*,\s*'\{\}'(::jsonb)?\s*\)\s*\|\|/;

const ALLOWLIST = new Set(['pages/api/admin/temp/clamp-publishedat-bumps.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

const files = walk(SRC)
  .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
  .filter((file) => !TEST_FILE.test(file));

const hasCoalesceMetaConcat = (source: string) => COALESCE_META_CONCAT.test(source);
const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');

describe("🔴 COALESCE(meta, '{}') || x is never used to merge into meta", () => {
  it('the scan reached the source tree', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it.each([
    ["meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('a', 1)"],
    ["meta = COALESCE(meta, '{}') || ${patch}::jsonb"],
    ["SET meta = COALESCE(m.meta, '{}'::jsonb) || x"],
    ['"meta" = COALESCE("meta", \'{}\'::jsonb)\n            || jsonb_build_object(\'a\', 1)'],
    ["meta = COALESCE( mv.meta , '{}'::jsonb ) ||\n x"],
  ])('flags %j', (source) => {
    expect(hasCoalesceMetaConcat(source)).toBe(true);
  });

  it.each([
    ['meta = ${asJsonbObjectSql(Prisma.raw(\'"meta"\'))} || ${patch}::jsonb'],
    ["jsonb_set(COALESCE(meta, '{}'::jsonb), '{a}', '1')"],
    ["COALESCE(u.meta->'scores', '{}') || s.scores"],
    ["COALESCE(meta, '{}'::jsonb) - 'key'"],
    ["COALESCE(metadata, '{}'::jsonb) || x"],
  ])('allows %j', (source) => {
    expect(hasCoalesceMetaConcat(source)).toBe(false);
  });

  it('no non-test file under src/ merges into meta with COALESCE(meta, ...) ||', () => {
    const offenders = files.filter(
      (file) => !ALLOWLIST.has(file) && hasCoalesceMetaConcat(read(file))
    );
    expect(
      offenders,
      'COALESCE only replaces SQL NULL; a stored JSON null concatenates into [null, {...}]. ' +
        'Merge through asJsonbObject / asJsonbObjectSql (src/server/utils/jsonb-object.ts).'
    ).toEqual([]);
  });

  it('every allowlisted file still contains the pattern', () => {
    const stale = [...ALLOWLIST].filter(
      (file) => !files.includes(file) || !hasCoalesceMetaConcat(read(file))
    );
    expect(stale, 'Remove these from ALLOWLIST: they no longer match.').toEqual([]);
  });
});
