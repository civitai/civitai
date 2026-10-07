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
  for (const match of source.matchAll(/creatorMilestone\.(find\w*)\s*\(/g)) {
    const arg = callArgument(source, match.index + match[0].length - 1);
    if (!/\bselect\s*:/.test(arg)) found.push(`${match[1]} without select`);
  }
  if (/\bdetector\s*:\s*true\b/.test(source)) found.push('detector: true');
  if (/\bmilestone\s*:\s*(true\b|\{\s*include\b)/.test(source))
    found.push('whole milestone relation');
  if (source.includes('"CreatorMilestone"')) {
    if (/\b\w+\.\*|SELECT\s+\*/i.test(source)) found.push('star select');
    if (/\b(SELECT|RETURNING)\b[^;`]*?[\s,.]"?detector"?\s*(,|\bFROM\b|`)/i.test(source))
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
