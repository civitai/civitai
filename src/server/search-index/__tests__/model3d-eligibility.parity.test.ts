import { describe, expect, it } from 'vitest';
import {
  checkEligibilityParity,
  expectEligibilityParity,
  type ParityRow,
  type ParitySpec,
} from '~/__tests__/eligibility-parity';
import { MODEL3D_ELIGIBLE_SQL } from '../../../../apps/event-engine/src/vector-sync/models3d/source';
import { model3dSemanticEligibleText } from '~/server/services/semantic-model3d-eligibility';

// Users: 1 clean, 2 banned, 3 deleted, 4 a CsamReport's subject, 5 its secondary user, 6 under an
// evidence hold, 7 a released hold, 8 a reported image owner, -1 the placeholder owner (named on a
// report, which holds nothing).
const SCHEMA = `
  CREATE TYPE "Model3DStatus" AS ENUM ('Draft', 'Published', 'Unpublished');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
  INSERT INTO "User" VALUES (1, NULL, NULL), (2, now(), NULL), (3, NULL, now()), (4, NULL, NULL),
    (5, NULL, NULL), (6, NULL, NULL), (7, NULL, NULL), (8, NULL, NULL), (-1, NULL, NULL);
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]');
  INSERT INTO "CsamReport" ("userId", details, images) VALUES
    (4, '{}', '[]'), (8, '{"secondaryUserId": "5"}', '[]'), (NULL, '{}', '[{"id": 210}, "220"]'),
    (-1, '{}', '[]'),
    -- Malformed rows the rule must read past without failing the statement.
    (NULL, '{"secondaryUserId": "abc"}', '{"id": 10}'),
    (NULL, '{"secondaryUserId": "123456789012345678901"}', '"10"');
  CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
  INSERT INTO "EvidenceHold" VALUES (6, NULL), (7, now());
  CREATE VIEW "EvidenceHeldUser" AS
    SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
  CREATE TABLE "Image" (
    id int PRIMARY KEY, "userId" int NOT NULL, ingestion "ImageIngestionStatus" NOT NULL,
    "needsReview" text, "tosViolation" boolean NOT NULL, "blockedFor" text,
    "nsfwLevel" int NOT NULL DEFAULT 1, minor boolean NOT NULL DEFAULT false,
    poi boolean NOT NULL DEFAULT false
  );
  CREATE TABLE "Model3D" (
    id int PRIMARY KEY,
    "userId" int NOT NULL REFERENCES "User"(id),
    "thumbnailImageId" int REFERENCES "Image"(id),
    status "Model3DStatus" NOT NULL,
    "deletedAt" timestamp(3),
    "nsfwLevel" int NOT NULL,
    "tosViolation" boolean NOT NULL,
    unlisted boolean NOT NULL,
    minor boolean NOT NULL,
    poi boolean NOT NULL,
    availability "Availability" NOT NULL
  );
`;

const eligible = {
  userId: '1',
  status: `'Published'`,
  deletedAt: 'NULL',
  nsfwLevel: '1',
  tosViolation: 'false',
  unlisted: 'false',
  minor: 'false',
  poi: 'false',
  availability: `'Public'`,
  /** The thumbnail's (userId, ingestion, needsReview, tosViolation, blockedFor), or false for none. */
  thumbnail: `1, 'Scanned', NULL, false, NULL` as string | false,
  thumbnailLevel: '1',
  /** The thumbnail's (minor, poi). */
  thumbnailFlags: 'false, false',
};

const model = (id: number, name: string, over: Partial<typeof eligible> = {}): ParityRow => {
  const c = { ...eligible, ...over };
  const imageId = id * 10;
  return {
    id,
    name,
    include: name === 'eligible' || name.startsWith('eligible:'),
    insert: [
      ...(c.thumbnail === false
        ? []
        : [
            `INSERT INTO "Image" VALUES (${imageId}, ${c.thumbnail}, ${c.thumbnailLevel}, ${c.thumbnailFlags})`,
          ]),
      `INSERT INTO "Model3D" VALUES (${id}, ${c.userId}, ${
        c.thumbnail === false ? 'NULL' : imageId
      },
        ${c.status}, ${c.deletedAt}, ${c.nsfwLevel}, ${c.tosViolation}, ${c.unlisted}, ${c.minor},
        ${c.poi}, ${c.availability})`,
    ].join(';\n'),
  };
};

const FROM = `FROM "Model3D" m JOIN "User" u ON u.id = m."userId"`;
// The event-engine's copy, which decides which 3D models get a point.
const COPY = `SELECT m.id ${FROM} WHERE ${MODEL3D_ELIGIBLE_SQL}`;

const spec: ParitySpec = {
  schema: SCHEMA,
  rows: [
    model(1, 'eligible'),
    model(2, 'status', { status: `'Draft'` }),
    model(3, 'deletedAt', { deletedAt: 'now()' }),
    model(4, 'nsfwLevel', { nsfwLevel: '0' }),
    model(5, 'tosViolation', { tosViolation: 'true' }),
    model(6, 'unlisted', { unlisted: 'true' }),
    model(7, 'minor', { minor: 'true' }),
    model(8, 'availability', { availability: `'Unsearchable'` }),
    model(9, 'thumbnail', { thumbnail: false }),
    model(10, 'thumbnailScanned', { thumbnail: `1, 'Pending', NULL, false, NULL` }),
    model(11, 'thumbnailNotInReview', { thumbnail: `1, 'Scanned', 'minor', false, NULL` }),
    model(12, 'thumbnailTos', { thumbnail: `1, 'Scanned', NULL, true, NULL` }),
    model(13, 'poi', { poi: 'true' }),
    model(14, 'bannedOwner', { userId: '2', thumbnail: `2, 'Scanned', NULL, false, NULL` }),
    model(15, 'deletedOwner', { userId: '3', thumbnail: `3, 'Scanned', NULL, false, NULL` }),
    // The owner held while the thumbnail belongs to someone clean: only the model's owner gate sees it.
    model(16, 'ownerReported', { userId: '4' }),
    model(17, 'ownerSecondaryReported', { userId: '5' }),
    model(18, 'ownerEvidenceHold', { userId: '6' }),
    model(19, 'thumbnailBlockedCsam', { thumbnail: `1, 'Scanned', NULL, false, 'CSAM'` }),
    model(21, 'thumbnailListed', {}),
    model(22, 'thumbnailListedAsText', {}),
    model(23, 'thumbnailOwnerHeld', { thumbnail: `8, 'Scanned', NULL, false, NULL` }),
    // Every other value on each boundary, so a rule that widens or narrows one is caught.
    model(24, 'status:Unpublished', { status: `'Unpublished'` }),
    model(25, 'availability:Private', { availability: `'Private'` }),
    model(26, 'availability:EarlyAccess', { availability: `'EarlyAccess'` }),
    model(27, 'eligible:mature', { nsfwLevel: '16' }),
    // A released evidence hold holds nothing.
    model(28, 'eligible:releasedHold', {
      userId: '7',
      thumbnail: `7, 'Scanned', NULL, false, NULL`,
    }),
    model(29, 'modelBlocked', { nsfwLevel: '32' }),
    model(30, 'thumbnailBlockedLevel', { thumbnailLevel: '32' }),
    model(31, 'thumbnailUnrated', { thumbnailLevel: '0' }),
    model(32, 'thumbnailBlockedFor', { thumbnail: `1, 'Scanned', NULL, false, 'TOS'` }),
    model(33, 'thumbnailOwnerSecondaryReported', { thumbnail: `5, 'Scanned', NULL, false, NULL` }),
    model(34, 'thumbnailOwnerEvidenceHold', { thumbnail: `6, 'Scanned', NULL, false, NULL` }),
    // The thumbnail must be the model owner's own image.
    model(35, 'thumbnailOtherOwner', { thumbnail: `7, 'Scanned', NULL, false, NULL` }),
    model(36, 'thumbnailMinor', { thumbnailFlags: 'true, false' }),
    model(37, 'thumbnailPoi', { thumbnailFlags: 'false, true' }),
  ],
  clauses: [
    'status',
    'deletedAt',
    'nsfwLevel',
    'tosViolation',
    'unlisted',
    'minor',
    'poi',
    'availability',
    'bannedOwner',
    'deletedOwner',
    'ownerReported',
    'ownerSecondaryReported',
    'ownerEvidenceHold',
    'thumbnail',
    'thumbnailScanned',
    'thumbnailNotInReview',
    'thumbnailTos',
    'thumbnailBlockedCsam',
    'thumbnailListed',
    'thumbnailListedAsText',
    'thumbnailOwnerHeld',
    'modelBlocked',
    'thumbnailBlockedLevel',
    'thumbnailUnrated',
    'thumbnailBlockedFor',
    'thumbnailOwnerSecondaryReported',
    'thumbnailOwnerEvidenceHold',
    'thumbnailOtherOwner',
    'thumbnailMinor',
    'thumbnailPoi',
  ],
  site: async (prisma) =>
    (
      await prisma.$queryRawUnsafe<{ id: number }[]>(
        `SELECT m.id ${FROM} WHERE ${model3dSemanticEligibleText()}`
      )
    ).map((r) => Number(r.id)),
  copy: COPY,
};

describe('3D model semantic search eligibility', () => {
  it('the event-engine keeps exactly the 3D models the site rule keeps', async () => {
    await expectEligibilityParity(spec);
  });

  it('names the clause a copy dropped', async () => {
    const result = await checkEligibilityParity({
      ...spec,
      copy: COPY.replace(` AND NOT m.poi`, ''),
    });
    expect(result.copy).toEqual({ missing: [], extra: ['poi'] });
  });
});
