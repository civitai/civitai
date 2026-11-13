import { describe, expect, it } from 'vitest';
import {
  checkEligibilityParity,
  expectEligibilityParity,
  type ParityRow,
  type ParitySpec,
} from '~/__tests__/eligibility-parity';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  STORY_LEVEL_SQL,
  STORYLINE_ELIGIBLE_SQL,
  STORYLINE_FROM,
} from '../../../../apps/event-engine/src/vector-sync/storylines/source';
import {
  storyLevelText,
  storylineSemanticEligibleText,
} from '~/server/services/storyline-visibility.sql';

const SCHEMA = `
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
  INSERT INTO "User" VALUES (1, NULL, NULL), (2, now(), NULL), (3, NULL, now()), (4, NULL, NULL),
    (5, NULL, NULL), (6, NULL, NULL), (-1, NULL, NULL);
  -- 4 is a CsamReport's subject, 5 its secondary user, 6 under an evidence hold, -1 the placeholder
  -- owner (named on a report, which holds none of its kept images).
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  INSERT INTO "CsamReport" ("userId", details, images) VALUES
    (4, '{}', '[]'), (NULL, '{"secondaryUserId": "5"}', '[{"id": 2100}]'), (NULL, '{}', '["2600"]'),
    (-1, '{}', '[]'),
    -- Malformed rows the rule must read past without failing the statement.
    (NULL, '{"secondaryUserId": "abc"}', '{"id": 100}'),
    (NULL, '{"secondaryUserId": "123456789012345678901"}', '"100"');
  CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
  INSERT INTO "EvidenceHold" VALUES (6, NULL);
  CREATE VIEW "EvidenceHeldUser" AS
    SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
  CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, "postId" int,
    "needsReview" text, "blockedFor" text);
  CREATE TABLE "Storyline" (
    id int PRIMARY KEY, "userId" int NOT NULL, "tosViolation" boolean NOT NULL,
    "maxNsfwLevel" int NOT NULL, "nsfwLevel" int NOT NULL, "moderatorNsfwLevel" int
  );
  CREATE TABLE "Post" (
    id int PRIMARY KEY, "userId" int NOT NULL, "tosViolation" boolean NOT NULL,
    "nsfwLevel" int NOT NULL, "publishedAt" timestamp(3), availability "Availability" NOT NULL
  );
  CREATE TABLE "StorylineChapter" (
    id int PRIMARY KEY, "storylineId" int NOT NULL, "postId" int, depth int NOT NULL,
    "removedAt" timestamp(3)
  );
`;

const eligible = {
  /** Storyline: owner, tosViolation. */
  owner: '1',
  tosViolation: 'false',
  /** false: no chapter 1 row. */
  chapter: true,
  removedAt: 'NULL',
  /** false: chapter 1's post is gone (postId NULL). */
  post: true,
  postAuthor: '1',
  postTos: 'false',
  postLevel: '1',
  publishedAt: 'now()',
  availability: `'Public'`,
  /** Chapter 1's image (userId, needsReview, blockedFor), or false for none. */
  image: `1, NULL, NULL` as string | false,
  /** A second image on chapter 1's post, the same shape, or false. */
  secondImage: false as string | false,
};

const storyline = (id: number, name: string, over: Partial<typeof eligible> = {}): ParityRow => {
  const c = { ...eligible, ...over };
  const postId = id * 10;
  return {
    id,
    name,
    include: name === 'eligible' || name.startsWith('eligible:'),
    insert: [
      `INSERT INTO "Storyline" VALUES (${id}, ${c.owner}, ${c.tosViolation}, 16, 0, NULL)`,
      ...(c.post
        ? [
            `INSERT INTO "Post" VALUES (${postId}, ${c.postAuthor}, ${c.postTos}, ${c.postLevel}, ${c.publishedAt}, ${c.availability})`,
            ...(c.image === false
              ? []
              : [
                  `INSERT INTO "Image" VALUES (${id * 100}, ${
                    c.image.split(',')[0]
                  }, ${postId},${c.image.slice(c.image.indexOf(',') + 1)})`,
                ]),
            ...(c.secondImage === false
              ? []
              : [
                  `INSERT INTO "Image" VALUES (${id * 100 + 1}, ${
                    c.secondImage.split(',')[0]
                  }, ${postId},${c.secondImage.slice(c.secondImage.indexOf(',') + 1)})`,
                ]),
          ]
        : []),
      ...(c.chapter
        ? [
            `INSERT INTO "StorylineChapter" VALUES (${postId}, ${id}, ${
              c.post ? postId : 'NULL'
            }, 0, ${c.removedAt})`,
          ]
        : []),
    ].join(';\n'),
  };
};

// The site's joins, as the storyline feed (getStorylinesInfinite) makes them.
const SITE = `SELECT st.id FROM "Storyline" st
  JOIN "User" u ON u.id = st."userId"
  LEFT JOIN "StorylineChapter" rc ON rc."storylineId" = st.id AND rc.depth = 0
  LEFT JOIN "Post" rp ON rp.id = rc."postId"
  LEFT JOIN "User" ru ON ru.id = rp."userId"
  WHERE ${storylineSemanticEligibleText()}`;
// The event-engine's copy, which decides which storylines get a point.
const COPY = `SELECT st.id FROM ${STORYLINE_FROM} WHERE ${STORYLINE_ELIGIBLE_SQL}`;

const spec: ParitySpec = {
  schema: SCHEMA,
  rows: [
    storyline(1, 'eligible'),
    storyline(2, 'tosViolation', { tosViolation: 'true' }),
    storyline(3, 'bannedOwner', { owner: '2' }),
    storyline(4, 'deletedOwner', { owner: '3' }),
    storyline(5, 'chapter1', { chapter: false, post: false }),
    storyline(6, 'chapter1Removed', { removedAt: 'now()' }),
    storyline(7, 'chapter1Post', { post: false }),
    storyline(8, 'postTos', { postTos: 'true' }),
    storyline(9, 'postAuthorBanned', { postAuthor: '2' }),
    storyline(10, 'postAuthorDeleted', { postAuthor: '3' }),
    storyline(11, 'postUnrated', { postLevel: '0' }),
    storyline(12, 'postBlocked', { postLevel: '32' }),
    storyline(13, 'postUnpublished', { publishedAt: 'NULL' }),
    storyline(14, 'postPublic', { availability: `'Private'` }),
    // A scheduled chapter 1 is indexed; the query's rootPublishedAt filter holds it back.
    storyline(15, 'eligible:scheduled', { publishedAt: `now() + interval '1 day'` }),
    storyline(16, 'eligible:mixedLevel', { postLevel: '5' }),
    storyline(17, 'ownerReported', { owner: '4', postAuthor: '1' }),
    storyline(18, 'ownerSecondaryReported', { owner: '5', postAuthor: '1' }),
    storyline(19, 'ownerEvidenceHold', { owner: '6', postAuthor: '1' }),
    // Chapter 1 by a held author, with an image whose owner is clean.
    storyline(20, 'postAuthorHeld', { postAuthor: '6' }),
    storyline(21, 'imageListed', {}),
    storyline(22, 'imageCsamReview', { image: `1, 'csam', NULL` }),
    storyline(23, 'imageBlockedCsam', { image: `1, NULL, 'CSAM'` }),
    storyline(24, 'imageOwnerHeld', { image: `4, NULL, NULL` }),
    storyline(25, 'eligible:noImage', { image: false }),
    storyline(26, 'imageListedAsText', {}),
    storyline(27, 'imageOwnerSecondaryReported', { image: `5, NULL, NULL` }),
    storyline(28, 'imageOwnerEvidenceHold', { image: `6, NULL, NULL` }),
    // An owner's verification block is theirs to lift, so it does not count their report against it.
    storyline(29, 'eligible:aiNotVerifiedImage', { image: `4, NULL, 'AiNotVerified'` }),
    storyline(30, 'eligible:placeholderImageOwner', { image: `-1, NULL, NULL` }),
    // One held image among clean ones is enough.
    storyline(31, 'anyImageHeld', { secondImage: `1, 'csam', NULL` }),
  ],
  clauses: [
    'tosViolation',
    'bannedOwner',
    'deletedOwner',
    'chapter1',
    'chapter1Removed',
    'chapter1Post',
    'postTos',
    'postAuthorBanned',
    'postAuthorDeleted',
    'postUnrated',
    'postBlocked',
    'postUnpublished',
    'postPublic',
    'ownerReported',
    'ownerSecondaryReported',
    'ownerEvidenceHold',
    'postAuthorHeld',
    'imageListed',
    'imageCsamReview',
    'imageBlockedCsam',
    'imageOwnerHeld',
    'imageListedAsText',
    'imageOwnerSecondaryReported',
    'imageOwnerEvidenceHold',
    'anyImageHeld',
  ],
  site: async (prisma) =>
    (await prisma.$queryRawUnsafe<{ id: number }[]>(SITE)).map((r) => Number(r.id)),
  copy: COPY,
};

describe('storyline semantic search eligibility', () => {
  it('the event-engine keeps exactly the storylines the site rule keeps', async () => {
    await expectEligibilityParity(spec);
  });

  it('names the clause a copy dropped', async () => {
    const result = await checkEligibilityParity({
      ...spec,
      copy: COPY.replace(` AND rc."removedAt" IS NULL`, ''),
    });
    expect(result.copy).toEqual({ missing: [], extra: ['chapter1Removed'] });
  });

  it("the payload's story level is the feed's", async () => {
    const harness = await startPglitePrisma(SCHEMA);
    try {
      // (post level, ceiling, title level, moderator level): unrated, blocked, gone, raised, masks.
      const cases: [number | null, number, number, number | null][] = [
        [1, 16, 0, null],
        [0, 8, 0, null],
        [32, 4, 0, null],
        [null, 16, 2, null],
        [1, 16, 4, null],
        [5, 16, 4, null],
        [5, 16, 2, null],
        [17, 16, 8, 2],
        [2, 16, 8, 0],
      ];
      for (const [i, [post, ceiling, title, mod]] of cases.entries()) {
        const id = i + 1;
        await harness.pg.exec(`
          INSERT INTO "Storyline" VALUES (${id}, 1, false, ${ceiling}, ${title}, ${mod ?? 'NULL'});
          ${
            post === null
              ? `INSERT INTO "StorylineChapter" VALUES (${id}, ${id}, NULL, 0, NULL);`
              : `INSERT INTO "Post" VALUES (${id}, 1, false, ${post}, now(), 'Public');
                 INSERT INTO "StorylineChapter" VALUES (${id}, ${id}, ${id}, 0, NULL);`
          }`);
      }
      const { rows } = await harness.pg.query<{ id: number; site: number; copy: number }>(
        `SELECT st.id, ${storyLevelText()} AS site, ${STORY_LEVEL_SQL} AS copy
         FROM ${STORYLINE_FROM} ORDER BY st.id`
      );
      expect(rows).toHaveLength(cases.length);
      for (const row of rows)
        expect([row.id, Number(row.copy)]).toEqual([row.id, Number(row.site)]);
      // The cases reach more than one level, so a constant copy would fail.
      expect(new Set(rows.map((r) => Number(r.site))).size).toBeGreaterThan(3);
    } finally {
      await harness.stop();
    }
  });
});
