import { describe, expect, it } from 'vitest';
import {
  checkEligibilityParity,
  expectEligibilityParity,
  type ParityRow,
  type ParitySpec,
} from '~/__tests__/eligibility-parity';
import { COLLECTION_ELIGIBLE_SQL } from '../../../../apps/event-engine/src/vector-sync/collections/source';
import { collectionSemanticEligibleText } from '~/server/services/semantic-collection-eligibility';

// Users: 1 clean, 2 banned, 3 deleted, 4 a CsamReport's subject, 5 its secondary user, 6 under an
// evidence hold, 7 a released hold, -1 the placeholder owner.
const USERS = `
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
  INSERT INTO "User" VALUES (1, NULL, NULL), (2, now(), NULL), (3, NULL, now()), (4, NULL, NULL),
    (5, NULL, NULL), (6, NULL, NULL), (7, NULL, NULL), (-1, NULL, NULL);
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  INSERT INTO "CsamReport" ("userId", details) VALUES (4, '{}'), (NULL, '{"secondaryUserId": "5"}');
  CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
  INSERT INTO "EvidenceHold" VALUES (6, NULL), (7, now());
  CREATE VIEW "EvidenceHeldUser" AS
    SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
`;

const SCHEMA = `${USERS}
  CREATE TYPE "CollectionReadConfiguration" AS ENUM ('Private', 'Public', 'Unlisted');
  CREATE TYPE "CollectionItemStatus" AS ENUM ('ACCEPTED', 'REVIEW', 'REJECTED');
  CREATE TABLE "Collection" (
    id int PRIMARY KEY,
    "userId" int NOT NULL REFERENCES "User"(id),
    read "CollectionReadConfiguration" NOT NULL,
    availability "Availability" NOT NULL,
    "nsfwLevel" int NOT NULL
  );
  CREATE TABLE "CollectionItem" (
    id serial PRIMARY KEY,
    "collectionId" int NOT NULL,
    status "CollectionItemStatus" NOT NULL
  );
`;

const eligible = {
  userId: '1',
  read: `'Public'`,
  availability: `'Public'`,
  nsfwLevel: '1',
  /** The statuses of its items. */
  items: ['ACCEPTED'] as string[],
};

const collection = (id: number, name: string, over: Partial<typeof eligible> = {}): ParityRow => {
  const c = { ...eligible, ...over };
  return {
    id,
    name,
    include: name === 'eligible' || name.startsWith('eligible:'),
    insert: [
      `INSERT INTO "Collection" VALUES (${id}, ${c.userId}, ${c.read}, ${c.availability}, ${c.nsfwLevel})`,
      ...c.items.map(
        (status) =>
          `INSERT INTO "CollectionItem" ("collectionId", status) VALUES (${id}, '${status}')`
      ),
    ].join(';\n'),
  };
};

const FROM = `FROM "Collection" c JOIN "User" u ON u.id = c."userId"`;
// The event-engine's copy, which decides which collections get a point.
const COPY = `SELECT c.id ${FROM} WHERE ${COLLECTION_ELIGIBLE_SQL}`;

const spec: ParitySpec = {
  schema: SCHEMA,
  rows: [
    collection(1, 'eligible'),
    collection(2, 'readPrivate', { read: `'Private'` }),
    collection(3, 'readUnlisted', { read: `'Unlisted'` }),
    collection(4, 'unsearchable', { availability: `'Unsearchable'` }),
    collection(5, 'availabilityPrivate', { availability: `'Private'` }),
    collection(6, 'placeholderOwner', { userId: '-1' }),
    collection(7, 'unrated', { nsfwLevel: '0' }),
    collection(8, 'blocked', { nsfwLevel: '32' }),
    collection(9, 'blockedWithOthers', { nsfwLevel: '33' }),
    collection(10, 'bannedOwner', { userId: '2' }),
    collection(11, 'deletedOwner', { userId: '3' }),
    collection(12, 'ownerReported', { userId: '4' }),
    collection(13, 'ownerSecondaryReported', { userId: '5' }),
    collection(14, 'ownerEvidenceHold', { userId: '6' }),
    collection(15, 'empty', { items: [] }),
    collection(16, 'noAcceptedItem', { items: ['REVIEW', 'REJECTED'] }),
    // Every other value on each boundary, so a rule that widens or narrows one is caught.
    collection(17, 'eligible:earlyAccess', { availability: `'EarlyAccess'` }),
    collection(18, 'eligible:mature', { nsfwLevel: '28' }),
    collection(19, 'eligible:releasedHold', { userId: '7' }),
    collection(20, 'eligible:oneAcceptedAmongOthers', { items: ['REJECTED', 'ACCEPTED'] }),
  ],
  clauses: [
    'readPrivate',
    'readUnlisted',
    'unsearchable',
    'availabilityPrivate',
    'placeholderOwner',
    'unrated',
    'blocked',
    'blockedWithOthers',
    'bannedOwner',
    'deletedOwner',
    'ownerReported',
    'ownerSecondaryReported',
    'ownerEvidenceHold',
    'empty',
    'noAcceptedItem',
  ],
  site: async (prisma) =>
    (
      await prisma.$queryRawUnsafe<{ id: number }[]>(
        `SELECT c.id ${FROM} WHERE ${collectionSemanticEligibleText()}`
      )
    ).map((r) => Number(r.id)),
  copy: COPY,
};

describe('collection semantic search eligibility', () => {
  it('the event-engine keeps exactly the collections the site rule keeps', async () => {
    await expectEligibilityParity(spec);
  });
  it('names the clause a copy dropped', async () => {
    const result = await checkEligibilityParity({
      ...spec,
      copy: COPY.replace(` AND ci.status = 'ACCEPTED'`, ''),
    });
    expect(result.copy).toEqual({ missing: [], extra: ['noAcceptedItem'] });
  });
});
