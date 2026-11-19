import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  createDocStore,
  createDocStoreRater,
  type DocStore,
} from '~/server/services/apps/doc-store';
import type { DocStoreDb } from '~/server/services/apps/doc-store';
import type * as ClientEnv from '~/env/client';
import type * as DocLevels from '~/server/services/apps/doc-levels';
import type * as TextScanMode from '~/server/services/text-scan/mode';
import type * as TextScanPrompt from '~/server/services/text-scan/prompt';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import { BOARD, ctx, freshApp, NS_PROD } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * THE RATER (content levels, build 3), end to end over a real store (PGlite, RLS on, the
 * content-level and rating-id migrations applied): a pass submits each unrated shared document's
 * text scan under its rating id; the scan's callback rates it as the higher of the text's level
 * and its images' levels, only while its text is the text that was scanned, and bound to the
 * revision the callback loaded; a stored active verdict for the same text rates it straight away;
 * a document whose images are not rated yet stays pending; and a scan the pipeline still owns is
 * never resubmitted.
 *
 * The text scan itself (`scanEntity`, the mode) and the image rows are stubbed; their own suites
 * cover them. Levels are NsfwLevel bits (PG 1, PG-13 2, R 4, X 8, XXX 16, Blocked 32), and the
 * text and image levels in each case differ, so the higher of the two is visible in the answer.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  scans: [] as { entityType: string; entityId: number }[],
  scanResult: { status: 'submitted', workflowId: 'wf-1' } as Record<string, unknown>,
  mode: 'active' as 'off' | 'shadow' | 'active',
  scanOn: true,
  maxInputChars: 200_000,
  levelsOn: new Set<string>(),
  synced: [] as { appBlockId: string; itemKey: string; level: number }[],
  /** Verdict rows by `<entity type>:<rating id>`. */
  rows: new Map<string, Record<string, unknown>>(),
  /** App ids whose manifest read throws. */
  brokenApps: new Set<string>(),
}));

vi.mock('~/env/client', async (importOriginal) => {
  const real = await importOriginal<typeof ClientEnv>();
  return { ...real, env: { ...real.env, NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.example/abc' } };
});
vi.mock('~/server/services/apps/doc-store-rater.instance', async () => {
  const { createDocStoreRater: create } = await import('~/server/services/apps/doc-store');
  let rater: ReturnType<typeof create> | undefined;
  return { getDocStoreRater: () => (rater ??= create({ db: h.db as DocStoreDb })) };
});
vi.mock('~/server/services/text-scan/submit', () => ({
  scanEntity: async (args: { entityType: string; entityId: number }) => {
    h.scans.push({ entityType: args.entityType, entityId: args.entityId });
    return h.scanResult;
  },
}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanMode>()),
  getTextScanMode: async () => h.mode,
  isTextScanEnabled: async () => h.scanOn,
  readTextScanRollouts: async () => ({ AppDoc: { shadow: 0, active: 100 } }),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => {
  const real = await importOriginal<typeof TextScanPrompt>();
  return {
    ...real,
    getTextScanConfig: async () => ({
      model: 'm',
      maxInputChars: h.maxInputChars,
      maxSegments: 10,
      thinking: false,
    }),
  };
});
vi.mock('~/server/services/apps/doc-levels', async (importOriginal) => ({
  ...(await importOriginal<typeof DocLevels>()),
  isSharedDocLevelsKnownOn: async (appId: string) => h.levelsOn.has(appId),
}));
vi.mock('~/server/services/blocks/app-sub-listing.service', () => ({
  syncSubListingRatingFromDoc: async (args: {
    appBlockId: string;
    itemKey: string;
    level: number;
  }) => {
    h.synced.push(args);
  },
}));

import {
  applyAppDocTextScan,
  appsWithLevelsOn,
  countUnratedDocs,
  rateUnratedDocs,
} from '~/server/services/apps/doc-rater.service';
import { loadAppDocSubjects } from '~/server/services/apps/doc-rater-subject';
import {
  asImageId,
  DOC_MEDIA_MAX_KEYS,
  docMediaKeys,
  isImageIdKey,
} from '~/server/services/apps/doc-rating-media';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import type { TextScanOutcome } from '~/server/services/text-scan/types';

const AUTHOR = 7101;
const MANIFEST = {
  storage: {
    collections: {
      board: { visibility: 'shared', write: 'own' },
      prefs: { visibility: 'private' },
    },
  },
};
// Image keys, as an app stores public image urls in its data.
const IMG_R = '11111111-2222-4333-8444-555555555555';
const IMG_UNSCANNED = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const IMG_NO_ROW = '12345678-90ab-4cde-8f01-234567890abc';
const IMG_FLAGGED = 'abcdef01-2345-4678-89ab-cdef01234567';
const imageUrl = (key: string) => `https://image.example/abc/${key}/width=450/${key}.jpeg`;
// Image ids, as an app stores them under an image-id key. Each is distinct from every level bit
// and from the other ids, so a level can only come from the row the id names.
const ID_R = 7301;
const ID_X = 7302;
const ID_UNSCANNED = 7303;
const ID_BLOCKED = 7304;
const ID_PG13 = 7305;
const ID_NO_ROW = 7399;
type ImageWhere = {
  url?: { in: string[] };
  id?: { in: number[] };
  OR?: { url?: { in: string[] }; id?: { in: number[] } }[];
};
const IMAGE_ROWS: {
  id: number;
  url: string;
  nsfwLevel: number;
  ingestion: string;
  needsReview?: string;
}[] = [
  { id: ID_R, url: IMG_R, nsfwLevel: 4, ingestion: 'Scanned' },
  { id: ID_UNSCANNED, url: IMG_UNSCANNED, nsfwLevel: 0, ingestion: 'Pending' },
  // Scanned at PG, but under moderator review: the site's image gate hides it at every level.
  { id: 7306, url: IMG_FLAGGED, nsfwLevel: 1, ingestion: 'Scanned', needsReview: 'minor' },
  { id: ID_X, url: 'key-of-x', nsfwLevel: 8, ingestion: 'Scanned' },
  { id: ID_BLOCKED, url: 'key-of-blocked', nsfwLevel: 0, ingestion: 'Blocked' },
  { id: ID_PG13, url: 'key-of-pg13', nsfwLevel: 2, ingestion: 'Scanned' },
];

let harness: Harness;
let store: DocStore;

beforeAll(async () => {
  harness = await createPgliteHarness({ rls: true, docLevels: true, docRatingId: true });
  h.db = harness.db;
  store = createDocStore({ db: harness.db });
});
afterAll(async () => {
  expect(harness.violations).toEqual([]);
  await harness?.close();
});

beforeEach(() => {
  h.scans.length = 0;
  h.synced.length = 0;
  h.scanResult = { status: 'submitted', workflowId: 'wf-1' };
  h.mode = 'active';
  h.scanOn = true;
  h.maxInputChars = 200_000;
  h.levelsOn.clear();
  h.rows.clear();
  h.brokenApps.clear();
  dbMock.dbRead.appBlock.findUnique.mockImplementation((async (args: { where: { id: string } }) => {
    if (h.brokenApps.has(args.where.id)) throw new Error('manifest read failed');
    return { manifest: MANIFEST };
  }) as never);
  dbMock.dbRead.image.findMany.mockImplementation((async (args: { where: ImageWhere }) => {
    // Either one condition, or an OR of them: a row matches by its url or by its id.
    const conditions = args.where.OR ?? [args.where];
    const urls = conditions.flatMap((c) => c.url?.in ?? []);
    const ids = conditions.flatMap((c) => c.id?.in ?? []);
    return IMAGE_ROWS.filter((r) => urls.includes(r.url) || ids.includes(r.id));
  }) as never);
  dbMock.dbWrite.entityModeration.findMany.mockImplementation((async (args: {
    where: { entityId: { in: number[] } };
  }) =>
    [...h.rows.values()].filter((r) =>
      args.where.entityId.in.includes(r.entityId as number)
    )) as never);
});

type Rating = {
  level: number | null;
  rating_status: string | null;
  rated_version: number | null;
  rating_id: number;
};

async function ratingOf(app: string, key: string): Promise<Rating> {
  const [row] = await harness.raw(
    `SELECT d.level, d.rating_status, d.rated_version, d.rating_id FROM appdata.doc d
     WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = 'board' AND d.key = $3`,
    [app, NS_PROD, key]
  );
  return row as Rating;
}

/** The hash of the text the doc with this rating id holds now. */
async function currentHash(ratingId: number) {
  return textScanTextHash((await loadAppDocSubjects([ratingId])).get(ratingId)!);
}

/** A verdict row for `ratingId`: `Succeeded` for the doc's current text unless said otherwise. */
async function verdictRow(
  ratingId: number,
  opts: { level?: number; status?: string; retryCount?: number; shadow?: boolean; hash?: string }
) {
  const entityType = opts.shadow ? 'AppDoc:shadow' : 'AppDoc';
  h.rows.set(`${entityType}:${ratingId}`, {
    entityType,
    entityId: ratingId,
    status: opts.status ?? 'Succeeded',
    retryCount: opts.retryCount ?? 0,
    nsfwLevel: opts.level ?? 1,
    result: { version: 1, textHash: opts.hash ?? (await currentHash(ratingId)) },
  });
}

/** The scan's callback for `ratingId`, as the callback loads the doc now. */
async function load(ratingId: number) {
  return (await loadAppDocSubjects([ratingId])).get(ratingId)!;
}

function outcome(level: number): TextScanOutcome {
  return {
    nsfw: { detectedLevel: level, declaredLevel: 0, raised: level > 1, reason: 'test' },
    nsfwLevel: level,
    triggeredLabels: [],
  };
}

async function callback(ratingId: number, level: number) {
  const subject = await load(ratingId);
  return applyAppDocTextScan({
    outcome: outcome(level),
    subject,
    textHash: textScanTextHash(subject),
  });
}

/** One doc written and submitted: its rating id. */
async function submitted(app: string, key: string, data: Record<string, unknown>) {
  await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, key, data);
  await rateUnratedDocs([app]);
  return (await ratingOf(app, key)).rating_id;
}

describe('a pass submits each unrated shared document’s text scan under its rating id', () => {
  it('the scan reads every string value and key of the document', async () => {
    const app = freshApp('RSVSUB');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { title: 'hello', tags: { blue: 1 } });
    const out = await rateUnratedDocs([app]);
    expect(out).toMatchObject({ ready: true, apps: 1, read: 1, acted: 1, submitted: 1 });
    const { rating_id: id } = await ratingOf(app, 'b1');
    expect(h.scans).toEqual([{ entityType: 'AppDoc', entityId: id }]);
    const subject = await load(id);
    expect(subject.fields[0].text?.split('\n').sort()).toEqual(['blue', 'hello', 'tags', 'title']);
    expect(subject.userId).toBe(AUTHOR);
    // Nothing is rated until the verdict arrives.
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });

  it.each([
    ['Pending', 0],
    ['Failed', 3],
    ['Expired', 0],
  ])(
    '🔴 a scan the pipeline still owns (%s, %i retries) is not resubmitted and spends no budget',
    async (status, retryCount) => {
      const app = freshApp('RSVOWNED');
      const id = await submitted(app, 'b1', { t: 'x' });
      await verdictRow(id, { status, retryCount });
      h.scans.length = 0;
      expect(await rateUnratedDocs([app])).toMatchObject({ read: 1, acted: 0, waiting: 1 });
      expect(h.scans).toEqual([]);
    }
  );

  it('🔴 a shadow scan left failed when the rollout moved to active is not waited on', async () => {
    const app = freshApp('RSVMOVED');
    const id = await submitted(app, 'b1', { t: 'x' });
    await verdictRow(id, { status: 'Failed', retryCount: 3, shadow: true });
    h.mode = 'active';
    h.scans.length = 0;
    expect(await rateUnratedDocs([app])).toMatchObject({ acted: 1, submitted: 1, waiting: 0 });
  });

  it('🔴 a pass resumes where the last one stopped, so the documents behind are reached', async () => {
    const app = freshApp('RSVRESUME');
    for (const k of ['a', 'b', 'c']) await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, k, { k });
    for (let i = 0; i < 3; i++) await rateUnratedDocs([app], { perPass: 1 });
    const ids = await Promise.all(
      ['a', 'b', 'c'].map(async (k) => (await ratingOf(app, k)).rating_id)
    );
    expect(h.scans.map((s) => s.entityId)).toEqual(ids);
  });

  it('a failed scan out of retries is submitted again', async () => {
    const app = freshApp('RSVSPENT');
    const id = await submitted(app, 'b1', { t: 'x' });
    await verdictRow(id, { status: 'Failed', retryCount: 9 });
    h.scans.length = 0;
    expect(await rateUnratedDocs([app])).toMatchObject({ acted: 1, submitted: 1 });
  });

  it('the budget counts submissions only: documents still waiting never use it up', async () => {
    const app = freshApp('RSVBUDGET');
    for (let i = 0; i < 3; i++) await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, `w${i}`, { i });
    await rateUnratedDocs([app]);
    for (let i = 0; i < 3; i++)
      await verdictRow((await ratingOf(app, `w${i}`)).rating_id, { status: 'Pending' });
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'new', { t: 'behind them' });
    h.scans.length = 0;
    const out = await rateUnratedDocs([app], { perPass: 1 });
    expect(out).toMatchObject({ waiting: 3, acted: 1, submitted: 1 });
    expect(h.scans).toHaveLength(1);
  });

  it('one app whose manifest cannot be read does not stop the others', async () => {
    const broken = freshApp('RSVBROKEN');
    const fine = freshApp('RSVFINE');
    await store.put(ctx(fine, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'x' });
    h.brokenApps.add(broken);
    const out = await rateUnratedDocs([broken, fine]);
    expect(out).toMatchObject({ apps: 2, failed: 1, submitted: 1 });
  });

  it('a canceled job ends the pass at the next page', async () => {
    const app = freshApp('RSVCANCEL');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'x' });
    await expect(
      rateUnratedDocs([app], {
        checkIfCanceled: () => {
          throw new Error('Job was canceled');
        },
      })
    ).rejects.toThrow('Job was canceled');
    expect(h.scans).toEqual([]);
  });

  it('with the text scan unable to scan AppDoc (kill switch), nothing is read or submitted', async () => {
    const app = freshApp('RSVKILL');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'x' });
    h.scanOn = false;
    expect(await rateUnratedDocs([app])).toMatchObject({ ready: true, read: 0, acted: 0 });
    expect((await ratingOf(app, 'b1')).rating_id).toBeNull();
  });
});

describe('🔴 the callback rates the document', () => {
  it('as the higher of its text and its images, recorded for its current version, and its card follows', async () => {
    const app = freshApp('RSVMAX');
    // Text rated PG-13 (2); it references an image rated R (4): the document is R.
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { pic: imageUrl(IMG_R), t: 'v1' });
    const id = await submitted(app, 'b1', { pic: imageUrl(IMG_R), t: 'v2' });
    expect(await callback(id, 2)).toEqual({ status: 'rated', level: 4 });
    expect(await ratingOf(app, 'b1')).toEqual({
      level: 4,
      rating_status: 'rated',
      rated_version: 2,
      rating_id: id,
    });
    expect(h.synced).toEqual([{ appBlockId: app, itemKey: 'b1', level: 4 }]);
  });

  it('a text level above its images is the level', async () => {
    const app = freshApp('RSVTEXT');
    const id = await submitted(app, 'b1', { pic: imageUrl(IMG_R) });
    expect(await callback(id, 16)).toEqual({ status: 'rated', level: 16 });
  });

  it('🔴 a verdict for text the document no longer has is dropped; the document stays pending', async () => {
    const app = freshApp('RSVSTALE');
    const id = await submitted(app, 'b1', { t: 'scanned text' });
    const scanned = await currentHash(id);
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'edited before the verdict' });
    const subject = await load(id);
    expect(await applyAppDocTextScan({ outcome: outcome(1), subject, textHash: scanned })).toEqual({
      status: 'stale',
    });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
    expect(h.synced).toEqual([]);
  });

  it('🔴 an edit AFTER the callback loaded the document drops the rating: it is bound to that load', async () => {
    const app = freshApp('RSVRACE');
    const id = await submitted(app, 'b1', { t: 'benign text' });
    const subject = await load(id);
    // The edit lands between the callback's load (and its hash check) and the rating.
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'something else entirely' });
    expect(
      await applyAppDocTextScan({
        outcome: outcome(1),
        subject,
        textHash: textScanTextHash(subject),
      })
    ).toEqual({ status: 'changed' });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });

  it('an image not rated yet leaves it pending', async () => {
    const app = freshApp('RSVMEDIA');
    const id = await submitted(app, 'b1', { pic: imageUrl(IMG_UNSCANNED) });
    expect(await callback(id, 1)).toEqual({ status: 'media-pending' });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });

  it('🔴 an image key in a url that names no image row leaves it pending; a bare id does not', async () => {
    const app = freshApp('RSVNOROW');
    const inUrl = await submitted(app, 'u1', { pic: imageUrl(IMG_NO_ROW) });
    expect(await callback(inUrl, 1)).toEqual({ status: 'media-pending' });
    const bare = await submitted(app, 'u2', { id: IMG_NO_ROW });
    expect(await callback(bare, 2)).toEqual({ status: 'rated', level: 2 });
  });

  it('🔴 an image carrying a moderation flag leaves it pending, whatever the image’s level', async () => {
    const app = freshApp('RSVFLAG');
    const id = await submitted(app, 'b1', { pic: imageUrl(IMG_FLAGGED) });
    expect(await callback(id, 1)).toEqual({ status: 'media-pending' });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });

  it('🔴 a percent-encoded image url still counts as an image url', async () => {
    const app = freshApp('RSVENC');
    const id = await submitted(app, 'b1', { pic: encodeURIComponent(imageUrl(IMG_NO_ROW)) });
    expect(await callback(id, 1)).toEqual({ status: 'media-pending' });
  });

  it('🔴 an image url split by a character a url parser drops (a tab) still counts', async () => {
    const app = freshApp('RSVTAB');
    const id = await submitted(app, 'b1', {
      pic: `https://image.example/abc/\t${IMG_NO_ROW}/width=450/x.jpeg`,
    });
    expect(await callback(id, 1)).toEqual({ status: 'media-pending' });
  });

  it('a uuid in a url on another host adds no level and does not hold the document', async () => {
    const app = freshApp('RSVOTHER');
    const id = await submitted(app, 'b1', { link: `https://elsewhere.example/item/${IMG_NO_ROW}` });
    expect(await callback(id, 2)).toEqual({ status: 'rated', level: 2 });
  });

  it('a text longer than one scan call is never rated from a verdict (it may cover only part)', async () => {
    const app = freshApp('RSVLONG');
    const id = await submitted(app, 'b1', { t: 'x'.repeat(40) });
    h.maxInputChars = 20;
    expect(await callback(id, 1)).toEqual({ status: 'too-long' });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });
});

describe('🔴 numeric image ids under an image-id key count like image keys', () => {
  it.each([
    ['imageIds', { imageIds: [ID_PG13, ID_R] }, 4],
    ['imageId', { imageId: ID_X }, 8],
    ['image_id, any case', { Image_ID: ID_R }, 4],
    ['image_ids', { image_ids: [ID_X] }, 8],
    ['nested deep in the data', { items: [{ card: { imageId: ID_X } }] }, 8],
    ['a string of digits', { imageIds: [String(ID_X)] }, 8],
  ])('an id under %s raises the document to its image’s level', async (_, data, level) => {
    const app = freshApp('RSVIDS');
    const id = await submitted(app, 'b1', data);
    expect(await callback(id, 1)).toEqual({ status: 'rated', level });
    expect((await ratingOf(app, 'b1')).level).toBe(level);
  });

  it('an image not rated yet leaves it pending', async () => {
    const app = freshApp('RSVIDPEND');
    const id = await submitted(app, 'b1', { imageIds: [ID_R, ID_UNSCANNED] });
    expect(await callback(id, 1)).toEqual({ status: 'media-pending' });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });

  it('a Blocked image blocks it', async () => {
    const app = freshApp('RSVIDBLOCK');
    const id = await submitted(app, 'b1', { imageId: ID_BLOCKED });
    expect(await callback(id, 1)).toEqual({ status: 'rated', level: 32 });
  });

  it('an id that names no image leaves it pending, as a key in an image url does', async () => {
    const app = freshApp('RSVIDNOROW');
    const id = await submitted(app, 'b1', { imageId: ID_NO_ROW });
    expect(await callback(id, 1)).toEqual({ status: 'media-pending' });
  });

  it('a number under any other key is not an image id, however image-like the key', async () => {
    const app = freshApp('RSVIDOTHER');
    const id = await submitted(app, 'b1', {
      id: ID_X,
      count: ID_X,
      seed: ID_X,
      ids: [ID_X],
      imageCount: ID_X,
      coverImageId: ID_X,
      images: [ID_X],
    });
    expect(await callback(id, 2)).toEqual({ status: 'rated', level: 2 });
  });

  it('a value under an image-id key that is not a whole positive id is not an id', async () => {
    const app = freshApp('RSVIDJUNK');
    const id = await submitted(app, 'b1', {
      imageIds: [` ${ID_X}`, `${ID_X}.0`, `-${ID_X}`, `${ID_X}abc`, ID_X + 0.5, -ID_X, 0],
      imageId: { nested: 'object' },
    });
    expect(await callback(id, 2)).toEqual({ status: 'rated', level: 2 });
  });

  it('keys and ids together: the highest of all of them, either way round', async () => {
    const app = freshApp('RSVIDMIX');
    const idHigher = await submitted(app, 'b1', { pic: imageUrl(IMG_R), imageId: ID_X });
    expect(await callback(idHigher, 1)).toEqual({ status: 'rated', level: 8 });
    const keyHigher = await submitted(app, 'b2', { pic: imageUrl(IMG_R), imageIds: [ID_PG13] });
    expect(await callback(keyHigher, 1)).toEqual({ status: 'rated', level: 4 });
  });

  it('a pass rating from a stored verdict reads the ids too', async () => {
    const app = freshApp('RSVIDPASS');
    const id = await submitted(app, 'b1', { imageId: ID_X });
    await verdictRow(id, { level: 1 });
    expect(await rateUnratedDocs([app])).toMatchObject({ rated: 1 });
    expect((await ratingOf(app, 'b1')).level).toBe(8);
  });

  it('THE image-id keys: these, compared lower-cased, and nothing else', () => {
    for (const key of ['imageId', 'imageIds', 'image_id', 'image_ids', 'IMAGEID', 'ImageIds'])
      expect(isImageIdKey(key)).toBe(true);
    for (const key of ['id', 'ids', 'image', 'images', 'coverImageId', 'imageIdx', 'image-id'])
      expect(isImageIdKey(key)).toBe(false);
  });

  it('an id is a whole number from 1 to the largest Image.id, or a string of digits naming one', () => {
    expect(asImageId(ID_X)).toBe(ID_X);
    expect(asImageId(String(ID_X))).toBe(ID_X);
    expect(asImageId(2_147_483_647)).toBe(2_147_483_647);
    for (const junk of [0, -1, 1.5, 2_147_483_648, '2147483648', '', ' 1', '+1', '1e3', null, true])
      expect(asImageId(junk)).toBeNull();
  });

  it('ids and keys share one cap: past it the document is not rated on a subset', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => 9000 + i);
    expect(docMediaKeys([], { imageIds: ids(DOC_MEDIA_MAX_KEYS) })).toMatchObject({
      ids: ids(DOC_MEDIA_MAX_KEYS),
    });
    expect(docMediaKeys([], { imageIds: ids(DOC_MEDIA_MAX_KEYS + 1) })).toEqual({
      overflow: 'too-many',
    });
    // One key on top of a full set of ids is one reference too many.
    expect(docMediaKeys([IMG_R], { imageIds: ids(DOC_MEDIA_MAX_KEYS) })).toEqual({
      overflow: 'too-many',
    });
    expect(docMediaKeys([IMG_R], { imageIds: ids(DOC_MEDIA_MAX_KEYS - 1) })).toMatchObject({
      keys: [IMG_R],
    });
  });
});

describe('without a submit: a stored verdict for the same text, or no text', () => {
  it('🔴 an active verdict stored for the current text rates it, with no scan', async () => {
    const app = freshApp('RSVSAME');
    const id = await submitted(app, 'b1', { t: 'same' });
    await verdictRow(id, { level: 8 });
    h.scans.length = 0;
    expect(await rateUnratedDocs([app])).toMatchObject({ rated: 1, acted: 0 });
    expect(h.scans).toEqual([]);
    expect((await ratingOf(app, 'b1')).level).toBe(8);
  });

  it('a stored verdict on a text longer than one scan call is not applied either', async () => {
    const app = freshApp('RSVSAMELONG');
    const id = await submitted(app, 'b1', { t: 'x'.repeat(40) });
    await verdictRow(id, { level: 1 });
    h.maxInputChars = 20;
    expect(await rateUnratedDocs([app])).toMatchObject({ rated: 0, skipped: 1 });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });

  it('🔴 a stored verdict for other text (an edit since) is not used: the new text is scanned', async () => {
    const app = freshApp('RSVSAMESTALE');
    const id = await submitted(app, 'b1', { t: 'before' });
    await verdictRow(id, { level: 1, hash: 'the hash of some earlier text' });
    h.scans.length = 0;
    expect(await rateUnratedDocs([app])).toMatchObject({ rated: 0, submitted: 1 });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });

  it('in shadow a stored shadow verdict rates nothing and submits nothing', async () => {
    const app = freshApp('RSVSHADOW');
    const id = await submitted(app, 'b1', { t: 'same' });
    await verdictRow(id, { level: 8, shadow: true });
    h.mode = 'shadow';
    h.scans.length = 0;
    expect(await rateUnratedDocs([app])).toMatchObject({ rated: 0, skipped: 1, acted: 0 });
    expect(h.scans).toEqual([]);
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });

  it('a document with no text rates PG, raised by its images; one with text is not', async () => {
    const app = freshApp('RSVEMPTY');
    // No string value and no object key.
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', {});
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b2', { pic: imageUrl(IMG_R) });
    h.scanResult = { status: 'skipped', reason: 'too-short' };
    const out = await rateUnratedDocs([app]);
    expect((await ratingOf(app, 'b1')).level).toBe(1);
    // b2 has text (its url), so `too-short` from a scan that looked earlier does not rate it.
    expect((await ratingOf(app, 'b2')).level).toBeNull();
    expect(out).toMatchObject({ rated: 1, skipped: 1 });
  });

  it('the text scan off for this document (rollout) rates nothing: the document stays pending', async () => {
    const app = freshApp('RSVOFF');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'x' });
    h.scanResult = { status: 'skipped', reason: 'off' };
    expect(await rateUnratedDocs([app])).toMatchObject({ rated: 0, skipped: 1 });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });
});

describe('which apps, and the backfill count', () => {
  it('the job rates only apps whose flag reads ON', async () => {
    dbMock.dbRead.appBlock.findMany.mockImplementation((async () => [
      { id: 'ab_ON' },
      { id: 'ab_OFF' },
    ]) as never);
    h.levelsOn.add('ab_ON');
    expect(await appsWithLevelsOn()).toEqual(['ab_ON']);
  });

  it('the backfill’s dry run counts the unrated shared documents and rates nothing', async () => {
    const app = freshApp('RSVCOUNT');
    for (const k of ['a', 'b', 'c']) await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, k, { k });
    expect(await countUnratedDocs(app)).toEqual({
      ready: true,
      collections: 1,
      unrated: 3,
      capped: false,
    });
    expect(h.scans).toEqual([]);
  });

  it('does nothing on a store without the rating-id migration', async () => {
    const bare = await createPgliteHarness({ rls: true, docLevels: true });
    try {
      expect(await createDocStoreRater({ db: bare.db }).ready()).toBe(false);
    } finally {
      await bare.close();
    }
  });
});
