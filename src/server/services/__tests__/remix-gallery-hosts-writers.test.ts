import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripCodeComments } from '~/test-utils/strip-code-comments';

/**
 * 🔴 Which host images have any remix-gallery placement is cached in Redis
 * (remix-gallery-hosts.cache.ts), and a host cached as having none skips the card summary and
 * gallery existence reads. An INSERT of a remix-gallery placement that does not bust leaves the
 * host's entries off its card and gallery for up to the cache TTL, once approved.
 *
 * So this file is a LEDGER of every write in the repository that can add or remove a Placement row
 * (Prisma create/upsert/delete, Kysely, raw SQL, a nested relation write), with how each is
 * handled and how many bust calls its file makes. It fails when the set of writes GROWS (a writer
 * nobody classified), when it SHRINKS (a listed writer moved, so its reason describes nothing), and
 * when a file's bust calls change. Status updates are not listed: membership is "any placement, in
 * any status", so they cannot change it. A count cannot see a wrong id or a bust before its write,
 * so remix-gallery.service.test.ts pins the busts behaviourally (paid insert, free insert,
 * approval).
 */

const ROOT = path.resolve(__dirname, '../../../..');
const WRITE_PATTERNS = [
  /\.placement\s*\.\s*(create|createMany|createManyAndReturn|upsert|delete|deleteMany)\s*\(/g,
  /\.(insertInto|deleteFrom|mergeInto)\(\s*['"]Placement(\s+as\s+\w+)?['"]/g,
  /\b(INSERT\s+INTO|DELETE\s+FROM)\s+("?\w+"?\.)?"?placement"?(?![\w"])/gi,
  // A nested write through a relation (User.placements, ...).
  /\bplacements\s*:\s*\{\s*(create|createMany|connectOrCreate|upsert|delete|deleteMany|set)\b/g,
];
const BUST_PATTERN = /\bbustRemixGalleryHosts\s*\(/g;

const LEDGER: Record<string, { writes: number; busts: number; why: string }> = {
  'src/server/services/remix-gallery.service.ts': {
    writes: 1,
    busts: 3,
    why:
      'createRemixGallerySubmission: the paid insert busts the host after the create; the free ' +
      'and team-waived insert (createFreePlacement) busts after it returns; approval busts too',
  },
  'src/server/services/free-placement.service.ts': {
    writes: 1,
    busts: 0,
    why:
      'createFreePlacement inserts for any surface; its one remix-gallery caller, ' +
      'createRemixGallerySubmission, busts the host once it returns',
  },
  'src/server/services/sticker-placement.service.ts': {
    writes: 2,
    busts: 0,
    why: "surface 'sticker': the insert and the free-claim discard are never remix-gallery rows",
  },
  'src/server/services/storyline-placement.service.ts': {
    writes: 1,
    busts: 0,
    why: "surface 'storyline' on a post: never a remix-gallery row",
  },
  'src/server/services/remix-gallery-hosts.cache.ts': {
    writes: 0,
    busts: 1,
    why: 'the definition of bustRemixGalleryHosts itself',
  },
  'src/server/services/promotion.service.ts': {
    writes: 1,
    busts: 0,
    why: "target type 'model' (PROMOTION_TARGET_TYPE): never a remix-gallery row",
  },
};

function count(text: string, patterns: RegExp[]) {
  return patterns.reduce((sum, re) => sum + (text.match(re) ?? []).length, 0);
}

function scan(root = ROOT) {
  const files = globSync('{src,apps,packages,scripts}/**/*.{ts,tsx,js,mjs,cjs,svelte}', {
    cwd: root,
    exclude: (f: string | { name: string }) =>
      /node_modules|\.svelte-kit|(^|[\\/])dist([\\/]|$)/.test(typeof f === 'string' ? f : f.name),
  })
    .map((f) => f.split(path.sep).join('/'))
    .filter(
      (f) =>
        !/(__tests__|\.test\.|\.spec\.|\/migrations\/)/.test(f) &&
        statSync(path.join(root, f)).isFile()
    );
  const found: Record<string, { writes: number; busts: number }> = {};
  for (const f of files) {
    const text = stripCodeComments(readFileSync(path.join(root, f), 'utf8'));
    const writes = count(text, WRITE_PATTERNS);
    const busts = count(text, [BUST_PATTERN]);
    if (writes || busts) found[f] = { writes, busts };
  }
  return { files, found };
}

describe('remix-gallery placement write ledger', () => {
  const { files, found } = scan();

  it('scans the source tree (instrument control)', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('src/server/services/remix-gallery.service.ts');
  });

  it('each pattern still matches what it was written for (instrument control)', () => {
    const [prisma, kysely, raw, nested] = WRITE_PATTERNS.map(
      (re) => new RegExp(re.source, re.flags.replace('g', ''))
    );
    expect('dbWrite.placement.create({').toMatch(prisma);
    expect('dbWrite.placement\n    .create({').toMatch(prisma);
    expect('tx.placement.deleteMany({').toMatch(prisma);
    expect(".insertInto('Placement')").toMatch(kysely);
    expect('INSERT INTO "Placement" (').toMatch(raw);
    expect('DELETE\n    FROM "Placement" p').toMatch(raw);
    expect('placements: { create: { surface } }').toMatch(nested);
    // Reads, status updates and other tables are not writes here.
    expect('FROM "Placement" pl').not.toMatch(raw);
    expect('dbWrite.placement.updateMany({').not.toMatch(prisma);
    expect('dbWrite.placement.findMany({').not.toMatch(prisma);
    expect('INSERT INTO "PlacementTransaction"').not.toMatch(raw);
    expect('tx.placementTransaction.createMany({').not.toMatch(prisma);
    expect('await bustRemixGalleryHosts([hostImageId]);').toMatch(new RegExp(BUST_PATTERN.source));
  });

  it('every insert or delete is listed with how it is handled, and nothing listed has gone away', () => {
    const actual = Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
    const expected = Object.fromEntries(
      Object.entries(LEDGER)
        .map(([f, { writes, busts }]) => [f, { writes, busts }] as const)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    expect(actual).toEqual(expected);
  });
});
