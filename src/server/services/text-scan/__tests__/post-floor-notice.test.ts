import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as Adapters from '~/server/services/moderation-adapters';
import type * as RatingReviewService from '~/server/services/rating-review.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The real text-scan callback and the real UpdateNsfwLevel job recompute over one post, against a fake
// database that derives the post's level as the SQL does.

vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'active'),
  getTextScanCsamMode: vi.fn(async () => 'off'),
}));
vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  getModerationAdapter: vi.fn(),
}));
vi.mock('~/server/services/rating-review.service', async (importOriginal) => ({
  ...(await importOriginal<typeof RatingReviewService>()),
  maybeAutoResolveRatingDisputeAfterScan: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
// Hand-listed: the real module builds Meilisearch clients and prom collectors at load.
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { getWorkflow } = await import('@civitai/orchestration-client');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
const { postTextScanAdapter } = await import('~/server/services/text-scan/adapters');
const { updateNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { createNotification } = await import('~/server/services/notification.service');

const POST_ID = 7;
const OWNER = 5;
const FLOOR = 8;
const OTHER_ID = 9;

registerTextScanProfile({
  entityType: 'Post',
  labels: ['nsfw'],
  load: async () => new Map([[POST_ID, { userId: OWNER, fields: [], declared: { nsfwLevel: 0 } }]]),
});

const RAISED = { nsfw: { level: 'x', reason: 'r' } };
const raisedWorkflow = {
  data: {
    metadata: {
      entityType: 'Post',
      entityId: POST_ID,
      emEntityType: 'Post',
      mode: 'active',
      externalId: 'ts-Post-7-abc-0-0',
      labels: ['nsfw'],
      promptIds: { base: 1, nsfw: 2 },
      model: 'air:test',
    },
    tags: ['text-scan'],
    steps: [
      {
        $type: 'chatCompletion',
        name: 'textScan',
        metadata: { segment: 0 },
        output: {
          choices: [{ message: { content: JSON.stringify(RAISED) }, finishReason: 'stop' }],
          parsed: RAISED,
        },
      },
    ],
  },
};

type Verdict = {
  workflowId: string;
  nsfwLevel: number | null;
  triggeredLabels: string[];
  result: unknown;
};
type PostState = { images: number; level: number; moderatorNsfwLevel: number | null };
let post: PostState;
let verdict: Verdict | null;
// A second post in the same batch, with its own verdict, for the tests that need one.
let other: (PostState & { verdict: Verdict | null }) | null;
const stateOf = (id: number) =>
  id === POST_ID ? { ...post, verdict } : id === OTHER_ID && other ? other : null;
const raisedVerdict = (triggeredLabels = ['nsfw']): Verdict => ({
  workflowId: 'wf-1',
  nsfwLevel: FLOOR,
  triggeredLabels,
  result: { version: 1 },
});

// scanFloorText and raiseNsfwLevelText in packages/civitai-shared/src/rated-entity-sql.ts.
const derivedLevel = (p: PostState, v: Verdict | null) => {
  const usable = v && (v.result as { version?: number } | null)?.version != null;
  const f = usable && (v?.nsfwLevel ?? 0) >= 2 ? v!.nsfwLevel! : 0;
  const l = p.images;
  const raised = l === 0 || f === 0 ? l : (l & ~(f - 1)) === 0 ? f : l & ~(f - 1);
  return p.moderatorNsfwLevel ?? raised;
};
const setLevel = (id: number, level: number) => {
  if (id === POST_ID) post.level = level;
  else if (other) other.level = level;
};

// A fake for the two raw statements this path sends; anything else fails the test.
const fakeRaw = async (query: Prisma.Sql) => {
  const sql = query.text.replace(/\s+/g, ' ').trim();
  const ids = query.values as number[];
  if (sql.startsWith('WITH next AS') && sql.includes('UPDATE "Post" p')) {
    // Without these the statement either fails in Postgres or returns unchanged posts too.
    expect(sql).toContain('p."nsfwLevel" "before"');
    expect(sql).toContain('WHERE next.id = p.id AND next."nsfwLevel" != p."nsfwLevel"');
    const changed = ids.flatMap((id) => {
      const state = stateOf(id);
      if (!state) return [];
      const before = state.level;
      const after = derivedLevel(state, state.verdict);
      if (after === before) return [];
      setLevel(id, after);
      return [{ id, before, after }];
    });
    return sql.includes('RETURNING p.id, next."before", p."nsfwLevel" "after"') ? changed : [];
  }
  if (sql.includes('FROM "Post" p JOIN "EntityModeration" em')) {
    const nsfwOnly = sql.includes(`'nsfw' = ANY(em."triggeredLabels")`);
    return ids.flatMap((id) => {
      const state = stateOf(id);
      const v = state?.verdict;
      if (!state || !v || (nsfwOnly && !v.triggeredLabels.includes('nsfw'))) return [];
      return [
        {
          id,
          userId: OWNER,
          title: 'T',
          moderatorNsfwLevel: state.moderatorNsfwLevel,
          workflowId: v.workflowId,
          triggeredLabels: v.triggeredLabels,
          images: state.images,
        },
      ];
    });
  }
  throw new Error(`unexpected raw query: ${sql}`);
};

const ratingNotices = () =>
  vi.mocked(createNotification).mock.calls.filter(([n]) => n.type === 'text-scan-rating-raised');

// What the UpdateNsfwLevel job runs once an image's level changes.
const imageRated = async (imageLevel: number, postIds = [POST_ID]) => {
  post.images |= imageLevel;
  await updateNsfwLevels({
    postIds,
    articleIds: [],
    bountyIds: [],
    bountyEntryIds: [],
    collectionIds: [],
    modelIds: [],
    modelVersionIds: [],
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  post = { images: 0, level: 0, moderatorNsfwLevel: null };
  verdict = null;
  other = null;
  vi.mocked(getModerationAdapter).mockReturnValue(postTextScanAdapter);
  dbMock.dbWrite.post.findUnique.mockImplementation((async () => ({
    nsfwLevel: post.level,
    moderatorNsfwLevel: post.moderatorNsfwLevel,
    userId: OWNER,
    title: 'T',
  })) as never);
  dbMock.dbWrite.entityModeration.findUnique.mockImplementation((async () => verdict) as never);
  dbMock.dbWrite.entityModeration.updateMany.mockImplementation((async ({
    data,
  }: {
    data: Partial<Verdict>;
  }) => {
    if (data.nsfwLevel) {
      verdict = {
        workflowId: data.workflowId ?? 'missing',
        nsfwLevel: data.nsfwLevel,
        triggeredLabels: data.triggeredLabels ?? [],
        result: data.result ?? null,
      };
    }
    return { count: 1 };
  }) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(fakeRaw as never);
});

describe('rating-raised notice when the floor lands on the level recompute', () => {
  it('notifies once when the verdict lands before the post has a rating', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(raisedWorkflow as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(post.level).toBe(0);
    expect(ratingNotices()).toHaveLength(0);

    await imageRated(1);
    await imageRated(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(1);
    expect(ratingNotices()[0][0]).toMatchObject({
      userId: OWNER,
      key: `text-scan-rating-raised-Post-${POST_ID}-${FLOOR}-wf-1`,
      details: { level: FLOOR, url: `/posts/${POST_ID}` },
    });
  });

  it('sends nothing on a later recompute once the callback notified, under the same key', async () => {
    post.images = 1;
    post.level = 1;
    vi.mocked(getWorkflow).mockResolvedValue(raisedWorkflow as never);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(ratingNotices()).toHaveLength(1);
    // The key the recompute sends in the first test, so an overlap of the two paths is one row.
    expect(ratingNotices()[0][0].key).toBe(`text-scan-rating-raised-Post-${POST_ID}-${FLOOR}-wf-1`);

    await imageRated(2);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(1);
  });

  it('does not notify when the images reach the level on their own', async () => {
    verdict = raisedVerdict();

    await imageRated(FLOOR);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('does not notify when the level falls to the floor', async () => {
    verdict = raisedVerdict();
    await imageRated(16);
    expect(post.level).toBe(16);

    post.images = 0;
    await imageRated(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('notifies when the floor only takes the post out of safe browsing', async () => {
    verdict = { ...raisedVerdict(), nsfwLevel: 4 };
    post.images = 1 | 4;

    await imageRated(0);

    expect(post.level).toBe(4);
    expect(ratingNotices()).toHaveLength(1);
    expect(ratingNotices()[0][0]).toMatchObject({ details: { level: 4 } });
  });

  // Post levels are masks here (bit_or of the images). A floor below the images' top level still
  // drops the safe-browsing bits, which is the rise the callback reports too.
  it('notifies at the top level when a lower floor drops safe browsing from a PG + X post', async () => {
    verdict = { ...raisedVerdict(), nsfwLevel: 4 };
    post.images = 1 | 8;

    await imageRated(0);

    expect(post.level).toBe(8);
    expect(ratingNotices()).toHaveLength(1);
    expect(ratingNotices()[0][0]).toMatchObject({ details: { level: 8 } });
  });

  it('does not notify when a lower floor leaves an R + X post as it was', async () => {
    verdict = { ...raisedVerdict(), nsfwLevel: 4 };
    post.images = 4 | 8;

    await imageRated(0);

    expect(post.level).toBe(4 | 8);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('notifies each risen post in a batch at its own level', async () => {
    verdict = raisedVerdict();
    other = {
      images: 1,
      level: 0,
      moderatorNsfwLevel: null,
      verdict: { ...raisedVerdict(), workflowId: 'wf-9', nsfwLevel: 4 },
    };

    await imageRated(1, [POST_ID, OTHER_ID]);

    expect(ratingNotices().map(([n]) => n.key)).toEqual([
      `text-scan-rating-raised-Post-${POST_ID}-${FLOOR}-wf-1`,
      `text-scan-rating-raised-Post-${OTHER_ID}-4-wf-9`,
    ]);
  });

  it('does not notify a post with a moderator rating', async () => {
    verdict = raisedVerdict();
    post.moderatorNsfwLevel = FLOOR;

    await imageRated(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it.each(['poi', 'minor'])('does not notify a raise deferred for %s', async (label) => {
    verdict = raisedVerdict(['nsfw', label]);

    await imageRated(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('does not notify a floor at the level the owner declared', async () => {
    verdict = raisedVerdict([]);

    await imageRated(1);

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });

  it('keeps the applied level when the notice lookup fails', async () => {
    verdict = raisedVerdict();
    dbMock.dbWrite.$queryRaw.mockImplementation((async (query: Prisma.Sql) => {
      if (query.text.includes('JOIN "EntityModeration" em')) throw new Error('read failed');
      return fakeRaw(query);
    }) as never);

    await expect(imageRated(1)).resolves.toBeUndefined();

    expect(post.level).toBe(FLOOR);
    expect(ratingNotices()).toHaveLength(0);
  });
});
