import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as GenerativeContent from '~/server/games/daily-challenge/generative-content';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';

// The daily job must set `metadata.autoTagId` on the collection it creates — that field is the
// entire mechanism by which challenge entries get tagged (applyCollectionAutoTag reads it on
// submission), and the "hide challenge entries" feed filter is worthless without it.
//
// This drives the real `createChallengesBatch` down to the `dbWrite.collection.create` call rather
// than asserting on source text, so it pins the tag to the code path that actually runs. Tagging
// added to a helper the job never calls would leave this red.
//
// `dbRead.$queryRaw` is routed by SQL shape, not call order, so reordering or adding an unrelated
// query upstream doesn't silently mis-feed the test.

const {
  mockDbReadQueryRaw,
  mockDbWriteQueryRawUnsafe,
  mockDbWriteExecuteRaw,
  mockDbWriteExecuteRawUnsafe,
  mockCollectionCreate,
  mockGetChallengeConfig,
  mockCreateChallengeRecord,
  mockGenerateCollectionDetails,
  mockGenerateArticle,
} = vi.hoisted(() => ({
  mockDbReadQueryRaw: vi.fn(),
  mockDbWriteQueryRawUnsafe: vi.fn().mockResolvedValue([{ id: 1000 }]),
  mockDbWriteExecuteRaw: vi.fn().mockResolvedValue(1),
  mockDbWriteExecuteRawUnsafe: vi.fn().mockResolvedValue(1),
  mockCollectionCreate: vi.fn().mockResolvedValue({ id: 4242 }),
  mockGetChallengeConfig: vi.fn(),
  mockCreateChallengeRecord: vi.fn().mockResolvedValue(31337),
  mockGenerateCollectionDetails: vi.fn().mockResolvedValue({ name: 'Challenge collection' }),
  mockGenerateArticle: vi.fn().mockResolvedValue({
    title: 'A challenge',
    content: 'body',
    theme: 'theme',
    invitation: 'invitation',
    themeElements: ['a'],
  }),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: mockDbReadQueryRaw },
  dbWrite: {
    $queryRawUnsafe: mockDbWriteQueryRawUnsafe,
    $executeRaw: mockDbWriteExecuteRaw,
    $executeRawUnsafe: mockDbWriteExecuteRawUnsafe,
    collection: { create: mockCollectionCreate },
  },
}));

// Imported at module scope but not reached by the creation path; cuts its
// clickhouse/redis/discord chain.
vi.mock('~/server/events', () => ({ eventEngine: {} }));

vi.mock('~/server/games/daily-challenge/generative-content', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerativeContent>()),
  generateCollectionDetails: mockGenerateCollectionDetails,
  generateArticle: mockGenerateArticle,
}));

vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  createChallengeRecord: mockCreateChallengeRecord,
}));

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof DailyChallengeUtils>()),
  getChallengeConfig: mockGetChallengeConfig,
}));

import { createChallengesBatch } from '../daily-challenge-processing';
import { dailyChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';

// The literal, not `dailyChallengeConfig.challengeTagId`. Reading the id from config makes the
// assertion below `undefined === undefined` on a tree where the field doesn't exist yet — it would
// pass against the exact code it exists to reject.
const CHALLENGE_TAG_ID = 676575;

// Routes each dbRead.$queryRaw by a fragment unique to that query.
function routeQuery(strings: TemplateStringsArray | string[]) {
  const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
  if (sql.includes('DISTINCT m."userId"')) return [{ userId: 11 }]; // source-collection creators
  if (sql.includes('resourceUserId')) return []; // users on cooldown
  if (sql.includes('unnest')) return []; // resources on cooldown
  if (sql.includes('DATE_TRUNC')) return []; // no challenge exists for the date yet
  if (sql.includes('DISTINCT(ci."modelId")')) return [{ id: 555 }];
  if (sql.includes('as creator')) return [{ modelId: 555, creator: 'someone', title: 'A model' }];
  if (sql.includes('FROM "ModelVersion" mv')) return [{ id: 777 }];
  if (sql.includes('JOIN "Post" p')) return [{ id: 999, url: 'cover-url' }]; // cover image
  throw new Error(`Unrouted dbRead.$queryRaw in test: ${sql.slice(0, 120)}`);
}

// preComputeContext throws unless defaultJudge is populated.
const configWithJudge = (overrides: Record<string, unknown> = {}) => ({
  ...dailyChallengeConfig,
  defaultJudge: {
    judgeId: 1,
    userId: 5,
    sourceCollectionId: 123,
    prompts: {
      systemMessage: '',
      collection: '',
      article: '',
      content: '',
      review: '',
      winner: '',
    },
    reviewTemplate: null,
  },
  ...overrides,
});

describe('daily challenge creation applies the challenge auto-tag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbReadQueryRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve(routeQuery(strings))
    );
    mockCollectionCreate.mockResolvedValue({ id: 4242 });
    mockCreateChallengeRecord.mockResolvedValue(31337);
    mockGetChallengeConfig.mockResolvedValue(configWithJudge());
  });

  it('carries the challenge tag id in the daily config', () => {
    expect(dailyChallengeConfig.challengeTagId).toBe(CHALLENGE_TAG_ID);
  });

  it('sets metadata.autoTagId to the configured challenge tag id', async () => {
    const result = await createChallengesBatch([new Date('2026-09-01T00:00:00Z')]);

    // createChallengesBatch swallows per-challenge errors into `failed`, so a green assertion
    // below would be meaningless without confirming the creation actually completed.
    expect(result).toMatchObject({ created: 1, failed: 0 });

    expect(mockCollectionCreate).toHaveBeenCalledTimes(1);
    const metadata = mockCollectionCreate.mock.calls[0][0].data.metadata;
    expect(metadata.autoTagId).toBe(CHALLENGE_TAG_ID);
  });

  it('takes the tag id from config rather than a hardcoded literal', async () => {
    mockGetChallengeConfig.mockResolvedValue(configWithJudge({ challengeTagId: 999001 }));

    const result = await createChallengesBatch([new Date('2026-09-01T00:00:00Z')]);
    expect(result).toMatchObject({ created: 1, failed: 0 });

    const metadata = mockCollectionCreate.mock.calls[0][0].data.metadata;
    expect(metadata.autoTagId).toBe(999001);
  });
});
