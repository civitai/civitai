import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A stored detector says exactly what earns its milestone, so `CreatorMilestone.detector` must never
 * be read anywhere but the grant job's loader. The column is `@no-type`, so the Prisma client cannot
 * return it today; these checks keep that true if the marker is dropped, and catch the raw SQL shapes
 * (`m.*`, the column by name) that would return it regardless.
 */

const ROOT = join(process.cwd(), 'src');
const LOADER = 'server/services/creator-milestone-stored.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function callArgument(source: string, openParen: number) {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(openParen + 1, i);
  }
  return source.slice(openParen + 1);
}

function detectorExposures(source: string) {
  const found: string[] = [];
  for (const match of source.matchAll(
    /creatorMilestone\.(find\w*|create\w*|update\w*|upsert|delete\w*)\s*\(/g
  )) {
    const arg = callArgument(source, match.index + match[0].length - 1);
    if (!/^\s*\{[^]*?\bselect\s*:/.test(arg) || /\binclude\s*:/.test(arg))
      found.push(`${match[1]} without select`);
  }
  if (/\bdetector\s*:\s*true\b/.test(source)) found.push('detector: true');
  if (/\bmilestone\s*:\s*(true\b|\{\s*include\b)/.test(source))
    found.push('whole milestone relation');
  if (/["']CreatorMilestone["']/.test(source)) {
    if (/\b\w+\.\*|(SELECT|RETURNING)\s+\*|selectAll\(/i.test(source)) found.push('star select');
    const keywords = /^(as|on|where|join|left|inner|set|using|order|group|limit|values)$/i;
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    const aliases = [...code.matchAll(/"CreatorMilestone"\s+(?:AS\s+)?(\w+)/gi)]
      .map((match) => match[1])
      .filter((alias) => !keywords.test(alias));
    for (const alias of new Set(aliases)) {
      const asValue = new RegExp(
        String.raw`(\bSELECT|\bRETURNING|,|\()\s*${alias}\s*(::\s*\w+\s*)?(,|\)|\bFROM\b|\bORDER\b|$)(?!\s*=>)`,
        'im'
      );
      if (asValue.test(code)) found.push('whole row');
    }
    if (/\b(SELECT|RETURNING)\b[^;`]*?[\s,.(]"?detector"?(?!\w)/i.test(source))
      found.push('detector column');
  }
  return found;
}

describe('detectorExposures', () => {
  it.each([
    [
      'a Prisma read without select',
      `dbRead.creatorMilestone.findMany({ where: { hidden: true } })`,
    ],
    ['a selected detector', `findMany({ select: { key: true, detector: true } })`],
    ['the whole relation', `userCreatorMilestone.findMany({ select: { milestone: true } })`],
    [
      'an included relation',
      `findMany({ select: { milestone: { include: { cosmetic: true } } } })`,
    ],
    ['a star select', 'sql`SELECT m.* FROM "CreatorMilestone" m`'],
    ['the column by name', 'sql`SELECT key, detector FROM "CreatorMilestone"`'],
    ['the column cast', 'sql`SELECT m.detector::text FROM "CreatorMilestone" m`'],
    ['the column aliased', 'sql`SELECT detector AS d FROM "CreatorMilestone"`'],
    ['a field of the column', `sql\`SELECT m.detector->>'sql' FROM "CreatorMilestone" m\``],
    ['a returning star', 'sql`UPDATE "CreatorMilestone" SET name = $1 RETURNING *`'],
    ['a whole row', 'sql`SELECT to_jsonb(m) FROM "CreatorMilestone" m`'],
    ['an aggregated row', 'sql`SELECT json_agg(m) FROM "CreatorMilestone" m`'],
    [
      'an ordered aggregate',
      'sql`SELECT jsonb_agg(cm ORDER BY cm.key) FROM "CreatorMilestone" AS cm`',
    ],
    ['a bare row', 'sql`SELECT m FROM "CreatorMilestone" m`'],
    ['a row cast to text', 'sql`SELECT m::text FROM "CreatorMilestone" m`'],
    ['a Kysely selectAll', `db.selectFrom('CreatorMilestone').selectAll().execute()`],
    [
      'a Prisma include',
      `creatorMilestone.findMany({ include: { cosmetic: { select: { id: true } } } })`,
    ],
    ['a Prisma update without select', `creatorMilestone.update({ where: { key }, data })`],
  ])('flags %s', (_, source) => {
    expect(detectorExposures(source)).not.toEqual([]);
  });

  it.each([
    [
      'a Prisma read with select',
      `dbRead.creatorMilestone.findMany({ where: { a: 1 }, select: s })`,
    ],
    ['a registry field', `if (entry.detector === 'x') return;`],
    ['named columns', 'sql`SELECT m.key, m.name FROM "CreatorMilestone" m`'],
    ['an aggregated column', 'sql`SELECT array_agg(m.key) FROM "CreatorMilestone" m`'],
    ['a column named like a word', 'sql`SELECT key FROM "CreatorMilestone" WHERE hidden`'],
  ])('passes %s', (_, source) => {
    expect(detectorExposures(source)).toEqual([]);
  });
});

describe('CreatorMilestone.detector', () => {
  it('is read only by the grant job loader', () => {
    const exposures = sourceFiles(ROOT).flatMap((file) => {
      const path = relative(ROOT, file).split('\\').join('/');
      if (path === LOADER) return [];
      return detectorExposures(readFileSync(file, 'utf8')).map((finding) => `${path}: ${finding}`);
    });
    expect(exposures).toEqual([]);
  });

  it('is read by the loader, so the scan above can see a real read', () => {
    expect(detectorExposures(readFileSync(join(ROOT, LOADER), 'utf8'))).toContain(
      'detector column'
    );
  });
});
