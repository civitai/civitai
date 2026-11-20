import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 A Prisma read of ImageConnection that includes or selects `image` spreads
 * `connectionImageExists` (src/server/selectors/image.selector.ts).
 *
 * The table has no foreign key to Image in production, so a deleted image leaves its connections
 * behind, and such a read then throws on the required relation and 500s the request. A read that
 * cannot see an orphan for another reason carries `image-connection-orphan-safe: <why>` inside
 * its call.
 */

const SRC = path.resolve(__dirname, '../../../../src');
const CODE_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEST_FILE = /\.test\.tsx?$|(^|\/)__tests__\//;
const CALL = /\bimageConnection\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow)\(/g;
const LOADS_IMAGE = /\b(select|include)\s*:\s*\{[^]*?\bimage\s*:/;
const SAFE = /connectionImageExists|image-connection-orphan-safe:/;

/** The text of each call's arguments, by balanced parentheses. */
export function connectionReads(source: string) {
  const calls: string[] = [];
  for (const match of source.matchAll(CALL)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(match.index, end + 1));
  }
  return calls;
}

export const unguardedReads = (source: string) =>
  connectionReads(source).filter((call) => LOADS_IMAGE.test(call) && !SAFE.test(call));

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
const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');

describe('🔴 an ImageConnection read that loads the image skips orphans', () => {
  it('the scan reached the source tree and its connection reads', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files.flatMap((file) => connectionReads(read(file))).length).toBeGreaterThan(5);
  });

  it.each([
    ["db.imageConnection.findMany({ where: { entityId: 1 }, select: { image: { select: { id: true } } } })"],
    ["tx.imageConnection.findMany({\n  where: { entityId },\n  include: { image: true },\n})"],
  ])('flags %j', (source) => {
    expect(unguardedReads(source)).toHaveLength(1);
  });

  it.each([
    ["db.imageConnection.findMany({ where: { entityId: 1, ...connectionImageExists }, include: { image: true } })"],
    ["db.imageConnection.findMany({ where: { entityId: 1 }, select: { imageId: true } })"],
    ["db.imageConnection.findMany({ where: { NOT: { image: { needsReview: 'csam' } } }, select: { imageId: true } })"],
  ])('passes %j', (source) => {
    expect(unguardedReads(source)).toEqual([]);
  });

  it('holds across src/', () => {
    const offenders = files.flatMap((file) =>
      unguardedReads(read(file)).map((call) => `${file}: ${call.slice(0, 80).replace(/\s+/g, ' ')}`)
    );
    expect(offenders, 'spread connectionImageExists into the where').toEqual([]);
  });
});
