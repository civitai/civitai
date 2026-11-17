import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileHarness } from '@civitai/db-queries/test-harness';

/**
 * The offline "no statement reads a view" check the Prisma-vs-Kysely parity suites share
 * (src/server/services/__tests__/hot-reads-*.kysely-parity.test.ts): compile a Kysely reader's
 * statements without a database and list the relations each one reads, so a suite can pin an exact
 * ledger and check none of them is declared `/// @view` in schema.full.prisma.
 */

const SCHEMA_PRISMA = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/civitai-db-schema/prisma/schema.full.prisma'
);

export const schemaLines = () => readFileSync(SCHEMA_PRISMA, 'utf-8').split('\n');
export const isViewMarker = (line: string) => line.trim() === '/// @view';

/**
 * Every model declared `/// @view` in schema.full.prisma. The marker sits above the model, in its
 * doc comment block, sometimes with a blank line between them, so the walk up from each `model`
 * line skips blank and `///` lines and stops at anything else. `markersAttributed` counts the
 * marker LINES attributed to a model (a model may carry the marker twice), so a suite can check
 * that none is missed.
 */
export function declaredViews(): Set<string> & { markersAttributed: number } {
  const lines = schemaLines();
  const views = new Set<string>();
  const attributed = new Set<number>();
  lines.forEach((line, i) => {
    const model = /^model (\w+) \{/.exec(line);
    if (!model) return;
    for (let j = i - 1; j >= 0 && (lines[j].trim() === '' || lines[j].startsWith('///')); j--)
      if (isViewMarker(lines[j])) {
        views.add(model[1]);
        attributed.add(j);
      }
  });
  return Object.assign(views, { markersAttributed: attributed.size });
}

/**
 * The quoted relation names a compiled statement reads FROM or JOINs, SORTED (so a ledger pins the
 * set of relations, with repeats, not the order the compiler emits them in).
 */
export function relationsOf(sqlText: string): string[] {
  return [...sqlText.matchAll(/\b(?:from|join)\s+"(\w+)"/gi)].map((match) => match[1]).sort();
}

/** The relations of each statement `read` issues, one sorted list per statement, in order. */
export async function compiledRelations(read: (db: never) => Promise<unknown>) {
  const harness = compileHarness();
  // The dummy driver returns no rows, so a read that requires one stops after its first statement.
  await read(harness.db as never).catch(() => undefined);
  return harness.queries.map((query) => relationsOf(query.sql));
}
