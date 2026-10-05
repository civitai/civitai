import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 `make_interval` never takes a bound parameter.
 *
 * Prisma binds a JS number as int8, and Postgres has only `make_interval(int4, …)`, so
 * `make_interval(mins => ${n})` inside `$queryRaw`/`Prisma.sql` throws 42883 on every call. Typecheck,
 * lint and a mocked-db unit test all pass over it, so the first sign is a job failing every tick in
 * prod — the storage-usage media job never ran once (868mahfyk), and 868kmpvw2 fixed two others.
 *
 * Inline the number instead: `${Prisma.raw(String(n))}`, or build the whole call as
 * `Prisma.raw(\`make_interval(mins => ${n})\`)`, where the `${}` is plain string interpolation.
 */

const SRC = path.resolve(__dirname, '../../../../src');
const CODE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SQL_TAG = /(\$queryRaw|\$executeRaw|\bsql)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

/** Whether `sql` ends inside the argument list of a `make_interval(` call. */
function insideMakeInterval(sql: string) {
  const at = sql.lastIndexOf('make_interval(');
  if (at === -1) return false;
  let depth = 0;
  for (const ch of sql.slice(at)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
  }
  return depth > 0;
}

/** The bound expressions passed to `make_interval` in SQL-tagged templates. */
function findBoundMakeIntervals(source: string): string[] {
  if (!source.includes('make_interval')) return [];
  const file = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      SQL_TAG.test(node.tag.getText(file)) &&
      ts.isTemplateExpression(node.template)
    ) {
      let sql = node.template.head.text;
      for (const span of node.template.templateSpans) {
        const expr = span.expression.getText(file);
        if (insideMakeInterval(sql) && !expr.startsWith('Prisma.raw(')) found.push(expr);
        sql += '?' + span.literal.text;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const files = walk(SRC);

describe('🔴 make_interval is never given a bound parameter', () => {
  it('the scan reached the source tree', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it.each([
    ['dbWrite.$queryRaw`SELECT now() - make_interval(mins => ${LEASE})`'],
    ['Prisma.sql`now() - make_interval(days => ${days})`'],
    ['db.$executeRaw`x < make_interval(0, 0, 0, ${n})`'],
    ["db.$queryRaw`${Prisma.raw('a')} < now() - make_interval(mins => ${n})`"],
  ])('flags %s', (source) => {
    expect(findBoundMakeIntervals(source)).toHaveLength(1);
  });

  it.each([
    ['Prisma.sql`now() - make_interval(days => ${Prisma.raw(String(days))})`'],
    ['const X = Prisma.raw(`make_interval(mins => ${MINUTES})`);'],
    ['db.$queryRaw`a >= b + ${Prisma.raw(`make_interval(mins => ${N})`)}`'],
    ['db.$queryRaw`now() - make_interval(mins => 45) AND id = ${id}`'],
    ['expect(text).toBe(`now() - make_interval(mins => ${MINUTES})`);'],
  ])('allows %s', (source) => {
    expect(findBoundMakeIntervals(source)).toEqual([]);
  });

  it('no file under src/ binds a make_interval argument', () => {
    const offenders = files.flatMap((file) =>
      findBoundMakeIntervals(readFileSync(file, 'utf8')).map(
        (expr) => `${path.relative(SRC, file)}: make_interval(… \${${expr}})`
      )
    );
    expect(
      offenders,
      'Prisma binds a JS number as int8 and make_interval takes int4, so this throws 42883 at runtime. ' +
        'Inline it with Prisma.raw(String(n)).'
    ).toEqual([]);
  });
});
