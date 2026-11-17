import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripCodeComments } from '~/test-utils/strip-code-comments';

/**
 * 🔴 An image's contest entries are cached in Redis (contest-collection-items.cache.ts) when the
 * `contest-collection-items-redis-cache` flag is on. A write that changes an entry and does not
 * bust it leaves the old status, tag or scores on the image page for up to the cache TTL.
 *
 * So this file is a LEDGER of every CollectionItem / CollectionItemScore write in the repository —
 * Prisma, Kysely, raw SQL and the nested `items: { create }` — with how each is handled, and how
 * many bust calls the file makes. It fails when the set of writes GROWS (a writer nobody has
 * classified), when it SHRINKS (a listed writer moved, so its reason describes nothing), and when
 * a file's bust calls change (a bust removed, or one added without updating the reason). A count
 * cannot see wrong ids, a dropped await or a bust moved ahead of its write, so these
 * collection.service writers are also pinned behaviourally in
 * contest-collection-items-redis-cache.test.ts: setItemScore, setCollectionItemsTag, bulkSaveItems
 * (the insert), saveItemInCollections, removeCollectionItem, updateCollectionItemsStatus and
 * removeEntityFromAllCollections. upsertCollection and bulkSaveItems' contest-only unpaid-entry
 * rollback are pinned by the per-file count below only.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const WRITE_PATTERNS = [
  /\.collectionItem(Score)?\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g,
  /\.(insertInto|updateTable|deleteFrom|mergeInto)\(\s*['"]CollectionItem(Score)?(\s+as\s+\w+)?['"]/g,
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+("?\w+"?\.)?"?collectionitem(score)?"?(?![\w"])/gi,
  // A nested write through a Collection create/update.
  /\bitems\s*:\s*\{\s*(create|createMany|connectOrCreate|upsert|update|updateMany|delete|deleteMany|set|connect)\b/g,
];
const BUST_PATTERN = /\bbustContestCollectionItemsCache(ForItems)?\s*\(/g;

const TTL = 'bounded by the cache TTL (CONTEST_COLLECTION_ITEMS_TTL)';
const LEDGER: Record<string, { writes: number; busts: number; why: string }> = {
  'src/server/services/collection.service.ts': {
    writes: 12,
    busts: 9,
    why:
      'every write busts: saveItemInCollections (insert, auto-feature tombstone, delete: one bust ' +
      'for the image after the transaction), upsertCollection (nested initial item), ' +
      'updateCollectionItemsStatus (by item id), bulkSaveItems (insert, and the unpaid-entry ' +
      'rollback delete), removeCollectionItem (tombstone + delete, image collections), setItemScore, ' +
      'removeEntityFromAllCollections (images), setCollectionItemsTag',
  },
  'src/server/services/challenge.service.ts': {
    writes: 1,
    busts: 1,
    why: 'review-request tag on the eligible images: busted',
  },
  'src/server/services/challenge-judge-review.service.ts': {
    writes: 2,
    busts: 2,
    why: 'judged tag set on one image, and cleared on a reset: both busted',
  },
  'src/server/services/post.service.ts': {
    writes: 1,
    busts: 1,
    why: "a post's collection tag onto its images: busted",
  },
  'src/server/services/auto-feature-images.service.ts': {
    writes: 1,
    busts: 0,
    why:
      'auto-featured picks go into the configured featured collection, which is not a contest, so ' +
      'its rows are not in the cached value',
  },
  'src/server/jobs/job-queue.ts': {
    writes: 4,
    busts: 1,
    why: 'entity cleanup: the image delete is busted; post, article and model rows are not image entries',
  },
  'src/server/jobs/collection-ai-review.ts': {
    writes: 1,
    busts: 0,
    why:
      'the claim sets reviewedById/reviewedAt/updatedAt only, none of which is cached; the status ' +
      'itself goes through updateCollectionItemsStatus, which busts',
  },
  'src/server/jobs/collection-contest-youtube-upload.ts': {
    writes: 1,
    busts: 0,
    why: 'updatedAt only, which is not cached',
  },
  'src/server/events/turf/flag-day.ts': {
    writes: 2,
    busts: 0,
    why:
      "the Flag Race swap replaces the home block's Collection, which is plain mode, not a contest, " +
      'so its rows are not in the cached value; it busts the home block cache instead',
  },
  'src/server/games/daily-challenge/challenge-rewards.ts': {
    writes: 2,
    busts: 1,
    why:
      `collection-wide REVIEW -> ACCEPTED/REJECTED at challenge end, by predicate: ${TTL}; ` +
      'refundBannedEntrantReviews clears the tag of the entries it refunded and busts them',
  },
  'src/server/jobs/daily-challenge-processing.ts': {
    writes: 3,
    busts: 0,
    why: `collection-wide: rejected-entry delete and two tag sweeps, by predicate: ${TTL}`,
  },
  'src/server/jobs/collection-game-processing.ts': {
    writes: 2,
    busts: 0,
    why: `collection-wide deletes on one board collection, by predicate: ${TTL}`,
  },
  'src/server/services/user.service.ts': {
    writes: 2,
    busts: 0,
    why: 'bookmark toggles: a Bookmark-mode collection, never Contest, so never in the cached value',
  },
  'src/server/services/model.service.ts': {
    writes: 1,
    busts: 0,
    why: 'model rows only; the cache holds image entries',
  },
  'src/pages/api/admin/migrate-likes.ts': {
    writes: 1,
    busts: 0,
    why: 'one-off migration of model likes; model rows only',
  },
  'src/pages/api/admin/migrate-likes-models.ts': {
    writes: 1,
    busts: 0,
    why: 'one-off migration of model likes; model rows only',
  },
  'apps/event-engine/scripts/lib/collection-item-adder.mjs': {
    writes: 1,
    busts: 0,
    why: `offline addedById backfill in a sibling app: ${TTL}`,
  },
  'apps/moderator/src/lib/server/image-deletion.ts': {
    writes: 1,
    busts: 0,
    why: `deletes the entries of an image that no longer exists, in a sibling app: ${TTL}`,
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
    if (writes) found[f] = { writes, busts: count(text, [BUST_PATTERN]) };
  }
  return { files, found };
}

describe('contest collection item write ledger', () => {
  const { files, found } = scan();

  it('scans the source tree (instrument control)', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toContain('src/server/services/collection.service.ts');
  });

  it('each pattern still matches what it was written for (instrument control)', () => {
    const [prisma, kysely, raw, nested] = WRITE_PATTERNS.map(
      (re) => new RegExp(re.source, re.flags.replace('g', ''))
    );
    expect('dbWrite.collectionItem.deleteMany({').toMatch(prisma);
    expect('dbWrite.collectionItem\n        .deleteMany({').toMatch(prisma);
    expect('dbWrite.collectionItemScore.upsert({').toMatch(prisma);
    expect(".deleteFrom('CollectionItem')").toMatch(kysely);
    expect('UPDATE "CollectionItem" ci SET').toMatch(raw);
    expect('DELETE\n    FROM "CollectionItem" ci').toMatch(raw);
    expect('INSERT INTO "CollectionItemScore" (').toMatch(raw);
    expect('items: { create: { ...collectionItem } }').toMatch(nested);
    // Reads are not writes.
    expect('FROM "CollectionItem" ci').not.toMatch(raw);
    expect('dbWrite.collectionItem.findMany({').not.toMatch(prisma);
    expect('UPDATE "CollectionItemTag"').not.toMatch(raw);
    expect('bustContestCollectionItemsCache([id])').toMatch(new RegExp(BUST_PATTERN.source));
  });

  it('every write is listed with how it is handled, and nothing listed has gone away', () => {
    const actual = Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
    const expected = Object.fromEntries(
      Object.entries(LEDGER)
        .map(([f, { writes, busts }]) => [f, { writes, busts }] as const)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    expect(actual).toEqual(expected);
  });
});
