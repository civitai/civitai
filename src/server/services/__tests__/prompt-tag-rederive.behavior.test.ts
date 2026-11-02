import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';
import type * as SystemCache from '~/server/services/system-cache';
import type * as Caches from '~/server/redis/caches';
import type * as Flipt from '~/server/flipt/client';

/**
 * Prompt re-derivation brings prompt tags in line with an edited prompt. The word list is faked:
 * `alpha` derives a level-only tag, `bravo` a tag an image mod rule names (so safety-class), and
 * `charlie` a lower level-only tag.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  tags: new Map<number, StoredTag>(),
  touched: false,
  appeals: [] as number[],
  failAudit: false,
  notifyFlag: false,
  ruleAction: 'Approve',
  nsfwGatedReview: false,
  moderated: [] as { id: number; name: string; nsfwLevel: number }[],
}));
type StoredTag = {
  tagId: number;
  name: string;
  source: string;
  confidence: number;
  automated: boolean;
  disabled: boolean;
  nsfwLevel: number;
};

const CATALOG = vi.hoisted(
  () =>
    ({
      'still life': { id: 1, nsfwLevel: 1 },
      grit: { id: 2, nsfwLevel: 4 },
      'level tag': { id: 10, nsfwLevel: 8 },
      'mild tag': { id: 11, nsfwLevel: 2 },
      'safety tag': { id: 20, nsfwLevel: 4 },
    } as Record<string, { id: number; nsfwLevel: number }>)
);
const byId = (id: number) => {
  const [name, tag] = Object.entries(CATALOG).find(([, t]) => t.id === id)!;
  return { name, ...tag };
};

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  auditMetaData: vi.fn(() => ({ success: true })),
  // Stands in for every check gated on the image being NSFW.
  includesInappropriate: vi.fn((_: unknown, nsfw: boolean) =>
    holder.nsfwGatedReview && nsfw ? 'minor' : false
  ),
  includesPoi: vi.fn(() => false),
  getTagsFromPrompt: vi.fn((prompt?: string) => {
    const found = [
      /\balpha\b/.test(prompt ?? '') && 'level tag',
      /\bbravo\b/.test(prompt ?? '') && 'safety tag',
      /\bcharlie\b/.test(prompt ?? '') && 'mild tag',
    ].filter(Boolean) as string[];
    return found.length ? found : false;
  }),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  stripBenignPhrases: vi.fn(async (text: string) => text.replace(/allowed alpha bravo/g, ' ')),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesModRules: vi.fn(async () => [
    {
      id: 1,
      definition: { type: 'tag', tags: ['safety tag'], match: 'any' },
      action: holder.ruleAction,
      reason: null,
    },
  ]),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getTagRules: vi.fn(async () => []),
  getModeratedTags: vi.fn(async () => holder.moderated),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  tagCacheByName: {
    fetch: vi.fn(async (names: string[]) => ({
      found: new Map(
        names
          .filter((name) => CATALOG[name])
          .map((name) => [name, { ...CATALOG[name], name, type: 'Label' }])
      ),
      missing: names.filter((name) => !CATALOG[name]),
    })),
    setMany: vi.fn(),
  },
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isFlipt: vi.fn(async () => holder.notifyFlag),
}));
// Hand-listed: the real module writes through the pg pool; these keep the tags in `holder.tags`.
vi.mock('~/server/services/tagsOnImageNew.service', () => ({
  insertTagsOnImageNew: vi.fn(
    async (rows: { tagId: number; source: string; confidence: number; automated: boolean }[]) => {
      for (const row of rows)
        if (!holder.tags.has(row.tagId))
          holder.tags.set(row.tagId, {
            tagId: row.tagId,
            name: byId(row.tagId).name,
            nsfwLevel: byId(row.tagId).nsfwLevel,
            source: row.source,
            confidence: row.confidence,
            automated: row.automated,
            disabled: false,
          });
    }
  ),
  deleteTagsOnImageNew: vi.fn(async (rows: { tagId: number }[]) => {
    for (const row of rows) holder.tags.delete(row.tagId);
  }),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import {
  buildAndInsertScanTags,
  dropZeroWeightTerms,
  getSafetyClassTagNames,
  rederivePromptTags,
  resolveScanOutcome,
  type ScanImage,
} from '../image-scan-pipeline';
import { insertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import { createNotification } from '~/server/services/notification.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { tagsNeedingReview } from '~/libs/tags';
import { poiWords } from '@civitai/mod-utils/prompt-audit/lists';
import { conditionalReviewTagNames } from '~/server/utils/tag-rules';
import { getTagRules } from '~/server/services/system-cache';

const ID = 7;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL DEFAULT 5,
      "postId" int,
      type text NOT NULL DEFAULT 'image',
      "createdAt" timestamp(3) NOT NULL DEFAULT now() - interval '30 days',
      "updatedAt" timestamp(3),
      "pHash" bigint,
      ingestion "ImageIngestionStatus",
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false,
      "needsReview" text,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      "scannedAt" timestamp(3),
      meta jsonb,
      metadata jsonb,
      "scanJobs" jsonb
    );
    CREATE TABLE "ImageTagForReview" ("imageId" int, "tagId" int);
    CREATE TABLE "TagsOnImageDetails" (
      "imageId" int, "tagId" int, automated boolean, disabled boolean
    );
    CREATE TABLE "User" (id int PRIMARY KEY, "isModerator" boolean);
    CREATE TABLE "TagsOnImageVote" ("imageId" int, "tagId" int, "userId" int);
  `);
});

const machine = (name: string): StoredTag => ({
  tagId: CATALOG[name].id,
  name,
  nsfwLevel: CATALOG[name].nsfwLevel,
  source: 'WD14',
  confidence: 80,
  automated: true,
  disabled: false,
});
const fromPrompt = (name: string, over: Partial<StoredTag> = {}): StoredTag => ({
  ...machine(name),
  source: 'Computed',
  confidence: 70,
  ...over,
});
const seedTags = (...tags: StoredTag[]) => {
  holder.tags.clear();
  for (const tag of tags) holder.tags.set(tag.tagId, tag);
};
const tagNames = () => [...holder.tags.values()].map((t) => t.name).sort();
type ImageRow = Record<string, unknown> & {
  nsfwLevel: number;
  minor: boolean;
  poi: boolean;
  pHash: unknown;
  scannedAt: Date;
};
const row = async () =>
  (await holder.db.query<ImageRow>(`SELECT * FROM "Image" WHERE id = ${ID}`)).rows[0];
const seedImage = async (prompt: string, over: Record<string, unknown> = {}) => {
  await holder.db.query(`DELETE FROM "Image"`);
  const fields = {
    ingestion: 'Scanned',
    nsfwLevel: 8,
    pHash: 99,
    scannedAt: '2026-01-01T00:00:00Z',
    scanJobs: JSON.stringify({ workflowId: 'wf-1' }),
    meta: JSON.stringify({ prompt }),
    ...over,
  };
  const cols = Object.keys(fields);
  await holder.db.query(
    `INSERT INTO "Image" (id, ${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${ID}, ${cols
      .map((_, i) => `$${i + 1}`)
      .join(', ')})`,
    Object.values(fields)
  );
};

beforeEach(async () => {
  vi.clearAllMocks();
  holder.ruleAction = 'Approve';
  holder.nsfwGatedReview = false;
  holder.moderated = [];
  await holder.db.exec(
    `DELETE FROM "ImageTagForReview"; DELETE FROM "TagsOnImageVote"; DELETE FROM "User"`
  );
  holder.touched = false;
  holder.appeals = [];
  holder.failAudit = false;
  holder.notifyFlag = false;
  // Only the selected keys, as Prisma returns them.
  dbMock.dbWrite.image.findUnique.mockImplementation((async ({
    select,
  }: {
    select: Record<string, boolean>;
  }) => {
    const full = await row();
    return Object.fromEntries(Object.keys(select).map((key) => [key, full[key]]));
  }) as never);
  dbMock.dbWrite.appeal.findMany.mockImplementation((async () =>
    holder.appeals.map((entityId) => ({ entityId }))) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const { affectedRows } = await holder.db.query(flat.text, flat.values as unknown[]);
    return affectedRows ?? 0;
  }) as never);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const text = strings.join('');
    const live = [...holder.tags.values()];
    if (text.includes('AS touched')) {
      await holder.db.exec(`DELETE FROM "TagsOnImageDetails"`);
      for (const t of live)
        await holder.db.query(`INSERT INTO "TagsOnImageDetails" VALUES ($1, $2, $3, $4)`, [
          ID,
          t.tagId,
          t.automated,
          t.disabled,
        ]);
      const flat = Prisma.sql(strings, ...(values as never[]));
      return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
    }
    if (text.includes('toi.source'))
      return text.includes('NOT toi.disabled')
        ? live.filter((t) => t.automated && !t.disabled)
        : live;
    if (text.includes('TagsOnImageDetails'))
      return live
        .filter((t) => t.automated && !t.disabled)
        .map((t) => ({ id: t.tagId, name: t.name, nsfwLevel: t.nsfwLevel, confidence: 90 }));
    if (text.includes('bannedAt'))
      return [{ ingestion: 'Scanned', blockedFor: null, nsfwLevel: 1, ownerBanned: false }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    if (holder.failAudit) throw new Error('db down');
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
});

describe('rederivePromptTags', () => {
  it('removes a level-only prompt tag the edited prompt no longer derives, and the level follows', async () => {
    seedTags(machine('still life'), fromPrompt('level tag'));
    await seedImage('a clean prompt');
    expect(await rederivePromptTags(ID)).toEqual({ status: 'applied', added: 0, removed: 1 });
    expect(tagNames()).toEqual(['still life']);
    expect((await row()).nsfwLevel).toBe(1);
  });

  it('adds the tag an edited prompt now derives, and the level rises', async () => {
    seedTags(machine('still life'));
    await seedImage('alpha', { nsfwLevel: 1 });
    expect(await rederivePromptTags(ID)).toEqual({ status: 'applied', added: 1, removed: 0 });
    expect(tagNames()).toEqual(['level tag', 'still life']);
    expect((await row()).nsfwLevel).toBe(8);
  });

  it('keeps a safety-class prompt tag after a clean edit, with the minor and poi flags', async () => {
    seedTags(machine('still life'), fromPrompt('safety tag'), fromPrompt('level tag'));
    await seedImage('a clean prompt', { minor: true, poi: true });
    await rederivePromptTags(ID);
    expect(tagNames()).toEqual(['safety tag', 'still life']);
    const after = await row();
    expect([after.minor, after.poi]).toEqual([true, true]);
    expect(after.nsfwLevel).toBe(4);
  });

  it('keeps the computed POI tag', async () => {
    seedTags(machine('still life'), fromPrompt('mild tag', { confidence: 100 }));
    await seedImage('a clean prompt', { nsfwLevel: 2 });
    expect(await rederivePromptTags(ID)).toEqual({ status: 'unchanged' });
    expect(tagNames()).toEqual(['mild tag', 'still life']);
  });

  it('never removes a machine tag, even one a tag rule now renames', async () => {
    vi.mocked(getTagRules).mockResolvedValueOnce([
      { type: 'Replace', toTag: 'still life', fromTag: 'grit' },
    ] as never);
    seedTags(machine('still life'), fromPrompt('level tag'));
    await seedImage('a clean prompt');
    await rederivePromptTags(ID);
    expect(tagNames()).toEqual(['grit', 'still life']);
  });

  it('never lowers the level below what the machine tags give', async () => {
    seedTags(machine('grit'), fromPrompt('level tag'));
    await seedImage('a clean prompt');
    await rederivePromptTags(ID);
    expect((await row()).nsfwLevel).toBe(4);
  });

  it.each([
    ['locked by a moderator', { nsfwLevelLocked: true }, 'level-locked'],
    ['blocked', { nsfwLevel: 32, blockedFor: 'moderated' }, 'blocked'],
    ['in review', { needsReview: 'tag' }, 'in-review'],
    ['ruled an acceptable minor', { acceptableMinor: true }, 'moderator-decision'],
    ['not scanned', { ingestion: 'Pending' }, 'not-scanned'],
    ['never scanned by a workflow', { scanJobs: null }, 'no-scan'],
  ])('leaves an image %s alone', async (_, over, reason) => {
    seedTags(machine('still life'), fromPrompt('level tag'));
    await seedImage('a clean prompt', over);
    const before = await row();
    expect(await rederivePromptTags(ID)).toEqual({ status: 'skipped', reason });
    expect(tagNames()).toEqual(['level tag', 'still life']);
    expect((await row()).nsfwLevel).toBe(before.nsfwLevel);
  });

  it('leaves an image under appeal alone', async () => {
    seedTags(machine('still life'), fromPrompt('level tag'));
    await seedImage('a clean prompt');
    holder.appeals = [ID];
    expect(await rederivePromptTags(ID)).toEqual({ status: 'skipped', reason: 'appeal' });
    expect(tagNames()).toEqual(['level tag', 'still life']);
  });

  it.each([
    ['a tag in the review queue', `INSERT INTO "ImageTagForReview" VALUES (${ID}, 10)`, {}],
    ['a disabled tag', '', { disabled: true }],
    ['a tag added by hand', '', { automated: false }],
    [
      'a moderator vote',
      `INSERT INTO "User" VALUES (9, true); INSERT INTO "TagsOnImageVote" VALUES (${ID}, 10, 9)`,
      {},
    ],
  ])('leaves an image with %s alone', async (_, sql, mark) => {
    seedTags(machine('still life'), fromPrompt('level tag', mark));
    await seedImage('a clean prompt');
    if (sql) await holder.db.exec(sql);
    expect(await rederivePromptTags(ID)).toEqual({
      status: 'skipped',
      reason: 'moderator-touched',
    });
    expect(tagNames()).toEqual(['level tag', 'still life']);
    expect((await row()).nsfwLevel).toBe(8);
  });

  it('does not count a vote by someone who is not a moderator', async () => {
    seedTags(machine('still life'), fromPrompt('level tag'));
    await seedImage('a clean prompt');
    await holder.db.exec(
      `INSERT INTO "User" VALUES (9, false); INSERT INTO "TagsOnImageVote" VALUES (${ID}, 10, 9)`
    );
    expect(await rederivePromptTags(ID)).toMatchObject({ status: 'applied' });
  });

  it('routes the image to review when the edit adds a tag a hold rule names', async () => {
    holder.ruleAction = 'Hold';
    seedTags(machine('still life'));
    await seedImage('bravo', { nsfwLevel: 1 });
    await rederivePromptTags(ID);
    expect(tagNames()).toEqual(['safety tag', 'still life']);
    expect((await row()).needsReview).toBe('modRule');
  });

  it('applies an edit whose own new tag flags the image for review', async () => {
    seedTags(machine('still life'));
    await seedImage('bravo', { nsfwLevel: 1 });
    vi.mocked(insertTagsOnImageNew).mockImplementationOnce(async (rows) => {
      for (const r of rows)
        holder.tags.set(r.tagId, {
          ...fromPrompt(byId(r.tagId).name),
          source: r.source as string,
        });
      await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'tag' WHERE id = ${ID}`);
    });
    expect(await rederivePromptTags(ID)).toMatchObject({ status: 'applied', added: 1 });
    expect(tagNames()).toEqual(['safety tag', 'still life']);
    expect((await row()).needsReview).toBe('tag');
  });

  it('backs off when a moderator acts on the image during the re-derivation', async () => {
    seedTags(machine('still life'), fromPrompt('level tag'));
    await seedImage('a clean prompt');
    vi.mocked(dbMock.dbWrite.appeal.findMany).mockImplementationOnce((async () => {
      await holder.db.exec(`UPDATE "Image" SET "nsfwLevelLocked" = true WHERE id = ${ID}`);
      return [];
    }) as never);
    expect(await rederivePromptTags(ID)).toEqual({
      status: 'skipped',
      reason: 'changed-during-rederive',
    });
    expect(tagNames()).toEqual(['level tag', 'still life']);
    expect((await row()).nsfwLevel).toBe(8);
  });

  it('sends no auto-block notice for a block that a moderator action stopped', async () => {
    holder.ruleAction = 'Block';
    seedTags(machine('still life'));
    await seedImage('bravo', { nsfwLevel: 1 });
    vi.mocked(dbMock.dbWrite.appeal.findMany).mockImplementationOnce((async () => {
      await holder.db.exec(`UPDATE "Image" SET "nsfwLevelLocked" = true WHERE id = ${ID}`);
      return [];
    }) as never);
    expect(await rederivePromptTags(ID)).toMatchObject({ reason: 'changed-during-rederive' });
    expect(vi.mocked(createNotification).mock.calls.map(([n]) => n.type)).toEqual([]);
  });

  it('leaves a lock another run now holds', async () => {
    seedTags(machine('still life'), fromPrompt('level tag'));
    await seedImage('a clean prompt');
    vi.mocked(redisMock.sysRedis.get).mockResolvedValue('another-run' as never);
    await rederivePromptTags(ID);
    expect(redisMock.sysRedis.del).not.toHaveBeenCalled();
  });

  it('waits for a concurrent re-derivation of the same image', async () => {
    seedTags(machine('still life'), fromPrompt('level tag'));
    await seedImage('a clean prompt');
    vi.mocked(redisMock.sysRedis.set).mockResolvedValueOnce(null as never);
    vi.mocked(redisMock.sysRedis.get).mockImplementation(
      async () => vi.mocked(redisMock.sysRedis.set).mock.calls.at(-1)?.[1] as never
    );
    expect(await rederivePromptTags(ID)).toMatchObject({ status: 'applied' });
    expect(redisMock.sysRedis.set).toHaveBeenCalledTimes(2);
    expect(redisMock.sysRedis.del).toHaveBeenCalled();
  });

  it('puts the tags back and leaves the level when it fails part-way', async () => {
    seedTags(machine('still life'), fromPrompt('level tag'));
    await seedImage('charlie');
    holder.failAudit = true;
    expect(await rederivePromptTags(ID)).toEqual({ status: 'failed' });
    expect(tagNames()).toEqual(['level tag', 'still life']);
    expect((await row()).nsfwLevel).toBe(8);
  });
});

describe('resolveScanOutcome monotone', () => {
  const image = async () => (await row()) as unknown as ScanImage;
  const flagged = { minor: true, poi: true, nsfwLevel: 8 };

  it('keeps minor, poi, pHash and scannedAt, and takes the level from the tags', async () => {
    seedTags(machine('still life'));
    await seedImage('a clean prompt', flagged);
    const before = await row();
    await resolveScanOutcome({ image: await image(), workflowId: 'wf-1', monotone: true });
    const after = await row();
    expect(after).toMatchObject({ minor: true, poi: true, needsReview: null, nsfwLevel: 1 });
    expect(Number(after.pHash)).toBe(99);
    expect(after.scannedAt.getTime()).toBe(before.scannedAt.getTime());
  });

  it('keeps a review flag set on the image before its write', async () => {
    seedTags(machine('still life'));
    await seedImage('a clean prompt', { ...flagged, needsReview: 'tag' });
    await resolveScanOutcome({ image: await image(), workflowId: 'wf-1', monotone: true });
    expect(await row()).toMatchObject({ needsReview: 'tag', nsfwLevel: 1 });
  });

  it('writes nothing over an image a moderator locked', async () => {
    seedTags(machine('still life'));
    await seedImage('a clean prompt', { ...flagged, nsfwLevelLocked: true });
    await expect(
      resolveScanOutcome({ image: await image(), workflowId: 'wf-1', monotone: true })
    ).rejects.toThrow();
    expect((await row()).nsfwLevel).toBe(8);
  });

  it('without the option, writes the audit as a scan always has', async () => {
    seedTags(machine('still life'));
    await seedImage('a clean prompt', { ...flagged, needsReview: 'tag' });
    await resolveScanOutcome({ image: await image(), workflowId: 'wf-2', pHash: BigInt(7) });
    const after = await row();
    expect(after).toMatchObject({ minor: false, poi: false, needsReview: null, nsfwLevel: 1 });
    expect(Number(after.pHash)).toBe(7);
    expect(after.scanJobs).toEqual({ workflowId: 'wf-2' });
  });
});

describe('prompt tags at scan time', () => {
  const scannedTagNames = () =>
    vi
      .mocked(insertTagsOnImageNew)
      .mock.calls.flatMap(([rows]) => rows.map((r) => byId(r.tagId).name))
      .sort();

  it('reads level-only tags from the allowlisted text and safety-class tags from the raw prompt', async () => {
    await buildAndInsertScanTags({
      imageId: ID,
      wdTags: {},
      ratingLevel: 'still life',
      prompt: 'allowed alpha bravo',
    });
    expect(scannedTagNames()).toEqual(['safety tag', 'still life']);
  });

  it('drops a level-only term weighted zero or below, never a safety-class one', async () => {
    await buildAndInsertScanTags({
      imageId: ID,
      wdTags: {},
      ratingLevel: 'still life',
      prompt: '(alpha:0), (bravo:0.0), (charlie:-0.5)',
    });
    expect(scannedTagNames()).toEqual(['safety tag', 'still life']);
  });

  it('decides review from the raw prompt when weights lower only the rating', async () => {
    holder.nsfwGatedReview = true;
    seedTags(machine('still life'));
    await seedImage('(alpha:0)', { nsfwLevel: 1 });
    await resolveScanOutcome({
      image: (await row()) as unknown as ScanImage,
      workflowId: 'wf-1',
      prompt: '(alpha:0)',
    });
    expect(await row()).toMatchObject({ nsfwLevel: 1, needsReview: 'minor' });
  });

  it('parses weights in linear time on a long run of digits', () => {
    const started = performance.now();
    dropZeroWeightTerms(`(:${'9'.repeat(100_000)}`);
    dropZeroWeightTerms(`(x:${'1'.repeat(5_000)}.${'1'.repeat(4_000)}`);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('keeps a positively weighted term', async () => {
    await buildAndInsertScanTags({
      imageId: ID,
      wdTags: {},
      ratingLevel: 'still life',
      prompt: '(alpha:1.2)',
    });
    expect(scannedTagNames()).toEqual(['level tag', 'still life']);
  });
});

describe('prompt rating notice', () => {
  const notices = () =>
    vi
      .mocked(createNotification)
      .mock.calls.filter(([n]) => n.type === 'image-prompt-rating-raised')
      .map(([n]) => n);

  it('tells the owner which tag raised the level, when the flag is on', async () => {
    holder.notifyFlag = true;
    seedTags(machine('still life'));
    await seedImage('alpha', { nsfwLevel: 1 });
    await rederivePromptTags(ID);
    expect(notices()).toEqual([
      expect.objectContaining({
        userId: 5,
        details: { imageId: ID, level: 8, tag: 'level tag' },
      }),
    ]);
  });

  it('sends nothing while the flag is off', async () => {
    seedTags(machine('still life'));
    await seedImage('alpha', { nsfwLevel: 1 });
    await rederivePromptTags(ID);
    expect(notices()).toEqual([]);
  });

  it('sends nothing when a safety-class tag is among the raisers', async () => {
    holder.notifyFlag = true;
    seedTags(machine('still life'));
    await seedImage('alpha bravo', { nsfwLevel: 1 });
    await rederivePromptTags(ID);
    expect(tagNames()).toContain('level tag');
    expect(notices()).toEqual([]);
  });

  it('sends nothing when the machine tags alone give the level', async () => {
    holder.notifyFlag = true;
    seedTags(machine('grit'));
    await seedImage('charlie', { nsfwLevel: 4 });
    await rederivePromptTags(ID);
    expect(tagNames()).toContain('mild tag');
    expect(notices()).toEqual([]);
  });
});

describe('getSafetyClassTagNames', () => {
  it('covers every source of review, block, minor and POI signals', async () => {
    holder.moderated = [
      { id: 30, name: 'Blocked Tag', nsfwLevel: 32 },
      { id: 31, name: 'level only', nsfwLevel: 8 },
    ];
    const names = await getSafetyClassTagNames();
    for (const name of [
      tagsNeedingReview[0],
      poiWords[0],
      conditionalReviewTagNames[0],
      'blocked tag',
      'safety tag',
    ])
      expect(names.has(name.toLowerCase()), name).toBe(true);
    expect(names.has('level only')).toBe(false);
  });
});
