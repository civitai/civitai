import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../../test/pglite';
import { pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';
import { INQUISITOR_IMAGE_SCHEMA } from './inquisitor-schema';

/**
 * How the Inquisitor page may show each item's image. A blocked image the public CDN will not serve
 * goes through `/api/retracted-media`, and only when that route would serve it to any moderator;
 * anything else blocked is drawn as the refusal placeholder and fetched from nowhere.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../../db', () => ({
  get dbRead() {
    throw new Error('the Inquisitor queue reads the primary');
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../../image-nsfw-level', () => ({ updateImageNsfwLevel: vi.fn() }));
const { patterns } = vi.hoisted(() => ({
  patterns: { current: null as { signal: RegExp[]; nonMinor: RegExp[] } | null },
}));
vi.mock('../../blocked-for-patterns', () => ({ blockedForPatterns: () => patterns.current }));
vi.mock('../../axiom', () => ({ logToAxiom: vi.fn() }));

const { getInquisitorQueue } = await import('../inquisitor.service');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../../../packages/civitai-db-schema/prisma/migrations'
);

const TABLES = [
  'KnightsVote',
  'KnightsQueueItem',
  'Image',
  'Post',
  'User',
  'CsamReport',
  'EvidenceHeldUser',
  'EvidenceHoldImage',
  'ImageCdnModeratorDelete',
];

let db: PGlite;

beforeAll(async () => {
  db = await freshPglite();
  await db.exec(INQUISITOR_IMAGE_SCHEMA);
  await db.exec(
    readFileSync(path.join(MIGRATIONS, '20261210120000_knights_v2_tables', 'migration.sql'), 'utf8')
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  patterns.current = null;
  await db.exec(TABLES.map((t) => `DELETE FROM "${t}";`).join('\n'));
});

const IMAGE = 990_000_001;
const OWNER = 990_100_001;

/** One image waiting on the Inquisitors, as the writeback leaves it when the image is blocked. */
async function queued(image: { ingestion?: string; blockedFor?: string | null; minor?: boolean }) {
  await db.query(
    `INSERT INTO "Image" (id, url, "userId", ingestion, "blockedFor", minor) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      IMAGE,
      'key-990000001',
      OWNER,
      image.ingestion ?? 'Blocked',
      image.blockedFor === undefined ? 'moderated' : image.blockedFor,
      image.minor ?? false,
    ]
  );
  await db.query(
    `INSERT INTO "KnightsQueueItem" ("id","questionKey","imageId","source","minRank","votesNeeded","priority","status","reason","createdAt")
     VALUES (990200001, 'knights.image.nsfwLevel', $1, 'scan-sample', 'Inquisitor', 5, 2, 'Inquisitor', 'blocked', now())`,
    [IMAGE]
  );
}

const media = async () => {
  const queue = await getInquisitorQueue();
  expect(queue).toHaveLength(1);
  return queue[0].media;
};

describe('getInquisitorQueue media', () => {
  it('shows an image that is not blocked from the CDN, as before', async () => {
    await queued({ ingestion: 'Scanned', blockedFor: null });
    expect(await media()).toBe('cdn');
  });

  it('sends a blocked image any moderator may see to the retracted-media route', async () => {
    await queued({});
    expect(await media()).toBe('retracted');
  });

  it.each([
    ['a flag on the image', async () => db.query(`UPDATE "Image" SET minor = true`)],
    [
      'a report listing it, not yet sent',
      async () =>
        db.query(
          `INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100002, '{}', $1)`,
          [JSON.stringify([{ id: IMAGE }])]
        ),
    ],
    [
      'a report listing it, sent',
      async () =>
        db.query(
          `INSERT INTO "CsamReport" ("userId", details, images, "reportSentAt") VALUES (990100002, '{}', $1, now())`,
          [JSON.stringify([{ id: IMAGE }])]
        ),
    ],
    [
      'a hold register entry',
      async () => db.query(`INSERT INTO "EvidenceHoldImage" ("imageId") VALUES ($1)`, [IMAGE]),
    ],
    [
      'a hold on its owner',
      async () => db.query(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES ($1)`, [OWNER]),
    ],
    ['a block with no reason', async () => db.query(`UPDATE "Image" SET "blockedFor" = NULL`)],
    [
      'a second flag on the image',
      async () => db.query(`UPDATE "Image" SET "acceptableMinor" = true`),
    ],
    ['a review flag', async () => db.query(`UPDATE "Image" SET "needsReview" = 'minor'`)],
    ['another review flag', async () => db.query(`UPDATE "Image" SET "needsReview" = 'csam'`)],
    [
      'a block reason that holds it',
      async () => db.query(`UPDATE "Image" SET "blockedFor" = 'CSAM'`),
    ],
    [
      'a block reason not known to be routine',
      async () => db.query(`UPDATE "Image" SET "blockedFor" = 'unlisted'`),
    ],
    [
      'a report listing another row on its url',
      async () => {
        await db.query(
          `INSERT INTO "Image" (id, url, "userId") VALUES (990000002, 'key-990000001', 990100003)`
        );
        await db.query(
          `INSERT INTO "CsamReport" ("userId", details, images) VALUES (990100002, '{}', $1)`,
          [JSON.stringify([{ id: 990_000_002 }])]
        );
      },
    ],
    [
      'a hold register entry on another row on its url',
      async () => {
        await db.query(
          `INSERT INTO "Image" (id, url, "userId") VALUES (990000002, 'key-990000001', 990100003)`
        );
        await db.query(`INSERT INTO "EvidenceHoldImage" ("imageId") VALUES (990000002)`);
      },
    ],
  ])('restricts a blocked image with %s', async (_label, mark) => {
    await queued({});
    await mark();
    expect(await media()).toBe('restricted');
  });

  it('reads block reasons against the configured patterns', async () => {
    await queued({ blockedFor: 'unlisted' });
    patterns.current = { signal: [], nonMinor: [/^unlisted$/] };
    expect(await media()).toBe('retracted');
  });

  it('marks each item by its own image', async () => {
    await queued({});
    await db.query(
      `INSERT INTO "Image" (id, url, "userId", ingestion, "blockedFor", minor) VALUES (990000003, 'key-990000003', 990100004, 'Blocked', 'moderated', true)`
    );
    await db.query(
      `INSERT INTO "KnightsQueueItem" ("id","questionKey","imageId","source","minRank","votesNeeded","priority","status","reason","createdAt")
       VALUES (990200002, 'knights.image.nsfwLevel', 990000003, 'scan-sample', 'Inquisitor', 5, 2, 'Inquisitor', 'blocked', now() + interval '1 second')`
    );
    const queue = await getInquisitorQueue();
    expect(queue.map((item) => [item.imageId, item.media])).toEqual([
      [990_000_001, 'retracted'],
      [990_000_003, 'restricted'],
    ]);
  });

  it('restricts every blocked image, and still lists the queue, when the access read fails', async () => {
    await queued({});
    await db.exec(`ALTER TABLE "CsamReport" RENAME TO "CsamReportAway"`);
    try {
      expect(await media()).toBe('restricted');
    } finally {
      await db.exec(`ALTER TABLE "CsamReportAway" RENAME TO "CsamReport"`);
    }
  });
});
