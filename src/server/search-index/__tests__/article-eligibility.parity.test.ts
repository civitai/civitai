import { describe, expect, it } from 'vitest';
import {
  checkEligibilityParity,
  expectEligibilityParity,
  type ParityRow,
  type ParitySpec,
} from '~/__tests__/eligibility-parity';
import { articleSearchEligibleWhere } from '~/server/search-index/articles.search-index';

const SCHEMA = `
  CREATE TYPE "ArticleStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'UnpublishedViolation', 'Processing');
  CREATE TYPE "ArticleIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'Rescan');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TABLE "Article" (
    id int PRIMARY KEY,
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
};
const article = (id: number, name: string, over: Partial<typeof eligible> = {}): ParityRow => {
  const c = { ...eligible, ...over };
  return {
    id,
    name,
    include: name === 'eligible',
    insert: `INSERT INTO "Article" VALUES (${id}, ${c.publishedAt}, ${c.status}, ${c.ingestion}, ${c.tosViolation}, ${c.availability})`,
  };
};

// The copy the semantic search sync will run. It moves beside the event-engine's content consumer
// with the articles index; until then it is pinned here.
const COPY = `
  SELECT id FROM "Article"
  WHERE "publishedAt" IS NOT NULL
    AND status = 'Published'
    AND ingestion = 'Scanned'
    AND NOT "tosViolation"
    AND availability <> 'Unsearchable'
`;

const spec: ParitySpec = {
  schema: SCHEMA,
  rows: [
    article(1, 'eligible'),
    article(2, 'publishedAt', { publishedAt: 'NULL' }),
    article(3, 'status', { status: `'Draft'` }),
    article(4, 'ingestion', { ingestion: `'Pending'` }),
    article(5, 'tosViolation', { tosViolation: 'true' }),
    article(6, 'availability', { availability: `'Unsearchable'` }),
    // Every other value on each boundary, so a rule that widens or narrows one is caught.
    article(7, 'status:Unpublished', { status: `'Unpublished'` }),
    article(8, 'status:UnpublishedViolation', { status: `'UnpublishedViolation'` }),
    article(9, 'status:Processing', { status: `'Processing'` }),
    article(10, 'ingestion:Blocked', { ingestion: `'Blocked'` }),
    article(11, 'ingestion:Error', { ingestion: `'Error'` }),
    article(12, 'ingestion:Rescan', { ingestion: `'Rescan'` }),
    { ...article(13, 'availability:Private', { availability: `'Private'` }), include: true },
    {
      ...article(14, 'availability:EarlyAccess', { availability: `'EarlyAccess'` }),
      include: true,
    },
  ],
  clauses: ['publishedAt', 'status', 'ingestion', 'tosViolation', 'availability'],
  site: async (prisma) =>
    (
      await prisma.article.findMany({ where: articleSearchEligibleWhere, select: { id: true } })
    ).map((a) => a.id),
  copy: COPY,
};

describe('article search eligibility', () => {
  it('the copy keeps exactly the articles the site rule keeps', async () => {
    await expectEligibilityParity(spec);
  });
});

describe('the parity harness', () => {
  it('names the clause a copy dropped', async () => {
    const result = await checkEligibilityParity({
      ...spec,
      copy: COPY.replace(`AND NOT "tosViolation"`, ''),
    });
    expect(result.copy).toEqual({ missing: [], extra: ['tosViolation'] });
    expect(result.site).toEqual({ missing: [], extra: [] });
  });

  it('names the clause the site rule dropped', async () => {
    const { availability: _, ...withoutAvailability } = articleSearchEligibleWhere;
    const result = await checkEligibilityParity({
      ...spec,
      site: async (prisma) =>
        (
          await prisma.article.findMany({ where: withoutAvailability, select: { id: true } })
        ).map((a) => a.id),
    });
    expect(result.site).toEqual({ missing: [], extra: ['availability'] });
  });

  it('refuses a clause with no row to exclude', async () => {
    await expect(
      checkEligibilityParity({ ...spec, clauses: [...spec.clauses, 'unlisted'] })
    ).rejects.toThrow('unlisted');
  });
});
