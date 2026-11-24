import { describe, expect, it } from 'vitest';
import {
  checkEligibilityParity,
  expectEligibilityParity,
  type ParityRow,
  type ParitySpec,
} from '~/__tests__/eligibility-parity';
import { BOUNTY_ELIGIBLE_SQL } from '../../../../apps/event-engine/src/vector-sync/bounties/source';
import { bountySemanticEligibleText } from '~/server/services/semantic-bounty-eligibility';

// Users: 1 clean, 2 banned, 3 deleted, 4 a CsamReport's subject, 5 its secondary user, -1 the
// placeholder owner.
const USERS = `
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
  INSERT INTO "User" VALUES (1, NULL, NULL), (2, now(), NULL), (3, NULL, now()), (4, NULL, NULL),
    (5, NULL, NULL), (-1, NULL, NULL);
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  INSERT INTO "CsamReport" ("userId", details) VALUES (4, '{}'), (NULL, '{"secondaryUserId": "5"}');
`;

const SCHEMA = `${USERS}
  CREATE TABLE "Bounty" (
    id int PRIMARY KEY,
    "userId" int REFERENCES "User"(id),
    availability "Availability" NOT NULL,
    poi boolean NOT NULL,
    "nsfwLevel" int NOT NULL
  );
`;

const eligible = { userId: '1', availability: `'Public'`, poi: 'false', nsfwLevel: '1' };

const bounty = (id: number, name: string, over: Partial<typeof eligible> = {}): ParityRow => {
  const b = { ...eligible, ...over };
  return {
    id,
    name,
    include: name === 'eligible' || name.startsWith('eligible:'),
    insert: `INSERT INTO "Bounty" VALUES (${id}, ${b.userId}, ${b.availability}, ${b.poi}, ${b.nsfwLevel})`,
  };
};

// A LEFT JOIN, so a bounty without an owner is excluded by the rule rather than by the join.
const FROM = `FROM "Bounty" b LEFT JOIN "User" u ON u.id = b."userId"`;
// The event-engine's copy, which decides which bounties get a point.
const COPY = `SELECT b.id ${FROM} WHERE ${BOUNTY_ELIGIBLE_SQL}`;

const spec: ParitySpec = {
  schema: SCHEMA,
  rows: [
    bounty(1, 'eligible'),
    bounty(2, 'noOwner', { userId: 'NULL' }),
    bounty(3, 'placeholderOwner', { userId: '-1' }),
    bounty(4, 'unsearchable', { availability: `'Unsearchable'` }),
    bounty(5, 'availabilityPrivate', { availability: `'Private'` }),
    bounty(6, 'poi', { poi: 'true' }),
    bounty(7, 'unrated', { nsfwLevel: '0' }),
    bounty(8, 'blocked', { nsfwLevel: '32' }),
    bounty(9, 'blockedWithOthers', { nsfwLevel: '33' }),
    bounty(10, 'bannedOwner', { userId: '2' }),
    bounty(11, 'deletedOwner', { userId: '3' }),
    bounty(12, 'ownerReported', { userId: '4' }),
    bounty(13, 'ownerSecondaryReported', { userId: '5' }),
    bounty(15, 'eligible:earlyAccess', { availability: `'EarlyAccess'` }),
    bounty(16, 'eligible:mature', { nsfwLevel: '28' }),
  ],
  clauses: [
    'noOwner',
    'placeholderOwner',
    'unsearchable',
    'availabilityPrivate',
    'poi',
    'unrated',
    'blocked',
    'blockedWithOthers',
    'bannedOwner',
    'deletedOwner',
    'ownerReported',
    'ownerSecondaryReported',
  ],
  site: async (prisma) =>
    (
      await prisma.$queryRawUnsafe<{ id: number }[]>(
        `SELECT b.id ${FROM} WHERE ${bountySemanticEligibleText()}`
      )
    ).map((r) => Number(r.id)),
  copy: COPY,
};

describe('bounty semantic search eligibility', () => {
  it('the event-engine keeps exactly the bounties the site rule keeps', async () => {
    await expectEligibilityParity(spec);
  });
  it('names the clause a copy dropped', async () => {
    const result = await checkEligibilityParity({
      ...spec,
      copy: COPY.replace(' AND NOT b.poi', ''),
    });
    expect(result.copy).toEqual({ missing: [], extra: ['poi'] });
  });
});
