import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';
import type * as SystemCache from '~/server/services/system-cache';
import type * as Caches from '~/server/redis/caches';

/**
 * Prompt keywords no longer write tags or rate the image; the image's own scan does. The checks
 * gated on the image being NSFW still see the keyword signal, so none runs less than before.
 * The prompts are synthetic versions of the public reports, through the real keyword matcher.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  tags: new Map<number, { name: string; source: string; confidence: number; nsfwLevel: number }>(),
  names: new Map<number, string>(),
  holdRuleTag: '',
}));
// Every tag but the machine one rates X: a stored keyword tag would show in the level.
const tagOf = vi.hoisted(() => (name: string) => {
  let id = 7;
  for (const char of name) id = (id * 31 + char.charCodeAt(0)) % 1_000_000;
  return { id: id + 100, name, nsfwLevel: name === 'still life' ? 1 : 8, type: 'Label' };
});

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  // Stands in for the prompt audit, which runs only on an image rated NSFW.
  auditMetaData: vi.fn(() => ({ success: false, blockedFor: ['audit'] })),
  includesPoi: vi.fn(() => false),
  // Stands in for the checks gated on the image being NSFW.
  includesInappropriate: vi.fn((_: unknown, nsfw: boolean) => (nsfw ? 'minor' : false)),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  stripBenignPhrases: vi.fn(async (text: string) => text),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesModRules: vi.fn(async () =>
    holder.holdRuleTag
      ? [
          {
            id: 1,
            definition: { type: 'tag', tags: [holder.holdRuleTag], match: 'any' },
            action: 'Hold',
            reason: null,
          },
        ]
      : []
  ),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getTagRules: vi.fn(async () => []),
  getModeratedTags: vi.fn(async () => []),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  tagCacheByName: {
    fetch: vi.fn(async (names: string[]) => ({
      found: new Map(names.map((name) => [name, tagOf(name)])),
      missing: [],
    })),
    setMany: vi.fn(),
  },
}));
// Hand-listed: the real module writes through the pg pool; these keep the tags in `holder.tags`.
vi.mock('~/server/services/tagsOnImageNew.service', () => ({
  insertTagsOnImageNew: vi.fn(
    async (rows: { tagId: number; source: string; confidence: number }[]) => {
      for (const row of rows) {
        const name = holder.names.get(row.tagId) ?? String(row.tagId);
        holder.tags.set(row.tagId, {
          name,
          source: row.source,
          confidence: row.confidence,
          nsfwLevel: tagOf(name).nsfwLevel,
        });
      }
    }
  ),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { buildAndInsertScanTags, resolveScanOutcome, type ScanImage } from '../image-scan-pipeline';
import {
  auditMetaData,
  getTagsFromPrompt,
  includesInappropriate,
  includesPoi,
} from '~/utils/metadata/audit';
import { dbMock } from '~/__tests__/mocks/db.mock';

const ID = 7;
const names = holder.names;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "updatedAt" timestamp(3),
      "pHash" bigint,
      ingestion "ImageIngestionStatus",
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      "needsReview" text,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      "scannedAt" timestamp(3),
      metadata jsonb,
      "scanJobs" jsonb
    );
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(includesPoi).mockReturnValue(false);
  vi.mocked(includesInappropriate).mockImplementation((_: unknown, nsfw?: boolean) =>
    nsfw ? 'minor' : false
  );
  holder.holdRuleTag = '';
  vi.mocked(auditMetaData).mockReturnValue({ success: false, blockedFor: ['audit'] } as never);
  holder.tags.clear();
  await holder.db.exec(
    `DELETE FROM "Image"; INSERT INTO "Image" (id, ingestion) VALUES (${ID}, 'Pending')`
  );
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const { affectedRows } = await holder.db.query(flat.text, flat.values as unknown[]);
    return affectedRows ?? 0;
  }) as never);
  dbMock.dbWrite.appeal.findMany.mockResolvedValue([]);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return [...holder.tags.entries()].map(([id, t]) => ({ id, ...t }));
    if (text.includes('bannedAt'))
      return [{ ingestion: 'Scanned', blockedFor: null, nsfwLevel: 1, ownerBanned: false }];
    if (text.includes('is_new_user')) return [{ isNewUser: false }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
});

const image = {
  id: ID,
  userId: 5,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  scannedAt: null,
  type: 'image',
  meta: {},
  metadata: {},
  postId: null,
  nsfwLevelLocked: false,
  nsfwLevel: 0,
  ingestion: 'Pending',
  blockedFor: null,
  needsReview: null,
} as unknown as ScanImage;

async function scan(prompt: string) {
  names.set(tagOf('still life').id, 'still life');
  for (const name of getTagsFromPrompt(prompt) || []) names.set(tagOf(name).id, name);
  await buildAndInsertScanTags({ imageId: ID, wdTags: {}, ratingLevel: 'still life', prompt });
  await resolveScanOutcome({ image, workflowId: 'wf-1', prompt });
  return (
    await holder.db.query<{
      nsfwLevel: number;
      needsReview: string | null;
      blockedFor: string | null;
    }>(`SELECT "nsfwLevel", "needsReview", "blockedFor" FROM "Image" WHERE id = ${ID}`)
  ).rows[0];
}

const KEYWORD_PROMPTS = [
  'A framed summa cum laude diploma leaning against a stack of law books.',
  'A single candle with a naked flame beside a contract on a wooden table.',
  'A porcelain teapot on a table, not nude, fully clothed scene.',
];
const CLEAN_PROMPTS = [
  'Still life of a signed contract on a dark wooden table beside a capped fountain pen.',
  'Cumulus clouds over a wheat field on a postcard lying on the table.',
];

describe('prompt keywords and the rating', () => {
  it.each([...KEYWORD_PROMPTS, ...CLEAN_PROMPTS])(
    'rates from the image, storing no keyword tag: %s',
    async (prompt) => {
      vi.mocked(includesInappropriate).mockReturnValue(false as never);
      vi.mocked(auditMetaData).mockReturnValue({ success: true } as never);
      const row = await scan(prompt);
      expect(row.nsfwLevel).toBe(1);
      expect([...holder.tags.values()].map((t) => t.name)).toEqual(['still life']);
    }
  );

  it('still runs the minor check gated on NSFW when only the prompt signals it', async () => {
    vi.mocked(auditMetaData).mockReturnValue({ success: true } as never);
    const row = await scan(KEYWORD_PROMPTS[1]);
    expect(row).toMatchObject({ needsReview: 'minor' });
  });

  it('still runs the prompt audit gated on NSFW when only the prompt signals it', async () => {
    vi.mocked(includesInappropriate).mockReturnValue(false as never);
    const row = await scan(KEYWORD_PROMPTS[1]);
    expect(row.blockedFor).toBe('audit');
  });

  it('still matches a mod rule on a keyword tag', async () => {
    vi.mocked(includesInappropriate).mockReturnValue(false as never);
    holder.holdRuleTag = (getTagsFromPrompt(KEYWORD_PROMPTS[1]) || [])[0];
    vi.mocked(auditMetaData).mockReturnValueOnce({ success: true } as never);
    const row = await scan(KEYWORD_PROMPTS[1]);
    expect(row).toMatchObject({ nsfwLevel: 1, needsReview: 'modRule' });
  });

  it('runs none of them for a clean prompt', async () => {
    const row = await scan(CLEAN_PROMPTS[0]);
    expect(row).toEqual({ nsfwLevel: 1, needsReview: null, blockedFor: null });
  });

  it('still writes the computed POI tag', async () => {
    vi.mocked(includesPoi).mockReturnValue('a person' as never);
    names.set(tagOf('a person').id, 'a person');
    await scan(CLEAN_PROMPTS[0]);
    expect(holder.tags.get(tagOf('a person').id)).toMatchObject({
      source: 'Computed',
      confidence: 100,
    });
  });
});
