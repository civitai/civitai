import { describe, expect, it } from 'vitest';
import {
  checkEligibilityParity,
  expectEligibilityParity,
  type ParityRow,
  type ParitySpec,
} from '~/__tests__/eligibility-parity';
import { ARTICLE_ELIGIBLE_SQL } from '../../../../apps/event-engine/src/vector-sync/articles/source';
import { articleSemanticEligibleWhere } from '~/server/search-index/articles.search-index';

const SCHEMA = `
  CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'UnpublishedViolation', 'Processing');
  CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'Rescan');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3));
  INSERT INTO "User" VALUES (1, NULL), (2, now());
  CREATE TABLE "Article" (
    id int PRIMARY KEY,
    "userId" int NOT NULL REFERENCES "User"(id),
    unlisted boolean NOT NULL,
    "publishedAt" timestamp(3),
    status "ArticleStatus" NOT NULL,
    ingestion "ArticleIngestionStatus" NOT NULL,
    "tosViolation" boolean NOT NULL,
    availability "Availability" NOT NULL
  );
`;

const eligible = {
  publishedAt: 'now()',
  status: `'Published'`,
  ingestion: `'Scanned'`,
  tosViolation: 'false',
  availability: `'Public'`,
  userId: '1',
  unlisted: 'false',
};
const article = (id: number, name: string, over: Partial<typeof eligible> = {}): ParityRow => {
  const c = { ...eligible, ...over };
  return {
    id,
    name,
    include: name === 'eligible',
    insert: `INSERT INTO "Article" (id, "userId", unlisted, "publishedAt", status, ingestion, "tosViolation", availability) VALUES (${id}, ${c.userId}, ${c.unlisted}, ${c.publishedAt}, ${c.status}, ${c.ingestion}, ${c.tosViolation}, ${c.availability})`,
  };
};

// The event-engine's copy, which decides which articles get a point.
const COPY = `SELECT a.id FROM "Article" a JOIN "User" u ON u.id = a."userId" WHERE ${ARTICLE_ELIGIBLE_SQL}`;

const spec: ParitySpec = {
  schema: SCHEMA,
  rows: [
    article(1, 'eligible'),
    article(2, 'publishedAt', { publishedAt: 'NULL' }),
    article(3, 'status', { status: `'Draft'` }),
    article(4, 'ingestion', { ingestion: `'Pending'` }),
    article(5, 'tosViolation', { tosViolation: 'true' }),
    article(6, 'availability', { availability: `'Unsearchable'` }),
    article(15, 'unlisted', { unlisted: 'true' }),
    article(16, 'bannedOwner', { userId: '2' }),
    // Every other value on each boundary, so a rule that widens or narrows one is caught.
    article(7, 'status:Unpublished', { status: `'Unpublished'` }),
    article(8, 'status:UnpublishedViolation', { status: `'UnpublishedViolation'` }),
    article(9, 'status:Processing', { status: `'Processing'` }),
    article(10, 'ingestion:Blocked', { ingestion: `'Blocked'` }),
    article(11, 'ingestion:Error', { ingestion: `'Error'` }),
    article(12, 'ingestion:Rescan', { ingestion: `'Rescan'` }),
    // Neither is readable by every viewer, so neither may reach the index.
    article(13, 'availability:Private', { availability: `'Private'` }),
    article(14, 'availability:EarlyAccess', { availability: `'EarlyAccess'` }),
  ],
  clauses: [
    'publishedAt',
    'status',
    'ingestion',
    'tosViolation',
    'availability',
    'unlisted',
    'bannedOwner',
  ],
  site: async (prisma) =>
    (
      await prisma.article.findMany({ where: articleSemanticEligibleWhere, select: { id: true } })
    ).map((a) => a.id),
  copy: COPY,
};

describe('article semantic search eligibility', () => {
  it('the event-engine keeps exactly the articles the site rule keeps', async () => {
    await expectEligibilityParity(spec);
  });
});

describe('the parity harness', () => {
  it('names the clause a copy dropped', async () => {
    const result = await checkEligibilityParity({
      ...spec,
      copy: COPY.replace(`AND NOT a."tosViolation"`, ''),
    });
    expect(result.copy).toEqual({ missing: [], extra: ['tosViolation'] });
    expect(result.site).toEqual({ missing: [], extra: [] });
  });

  it('names the clause the site rule dropped', async () => {
    const { availability: _, ...withoutAvailability } = articleSemanticEligibleWhere;
    const result = await checkEligibilityParity({
      ...spec,
      site: async (prisma) =>
        (
          await prisma.article.findMany({ where: withoutAvailability, select: { id: true } })
        ).map((a) => a.id),
    });
    expect(result.site).toEqual({
      missing: [],
      extra: ['availability', 'availability:Private', 'availability:EarlyAccess'],
    });
  });

  it('refuses a clause with no row to exclude', async () => {
    await expect(
      checkEligibilityParity({ ...spec, clauses: [...spec.clauses, 'uncovered'] })
    ).rejects.toThrow('uncovered');
  });
});
