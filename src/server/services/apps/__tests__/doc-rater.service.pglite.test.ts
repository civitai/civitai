import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  createDocStore,
  createDocStoreRater,
  type DocStore,
} from '~/server/services/apps/doc-store';
import type { DocStoreDb } from '~/server/services/apps/doc-store';
import type * as DocLevels from '~/server/services/apps/doc-levels';
import type * as TextScanMode from '~/server/services/text-scan/mode';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import { BOARD, ctx, freshApp, NS_PROD } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * THE RATER (content levels, build 3), end to end over a real store (PGlite, RLS on, the
 * content-level and rating-id migrations applied): a pass submits each unrated shared document's
 * text scan under its rating id; the scan's callback rates it as the higher of the text's level
 * and its images' levels, only while its text is the text that was scanned, and bound to its
 * revision; a stored verdict for the same text rates it straight away; and a document whose
 * images are not rated yet stays pending.
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
  levelsOn: new Set<string>(),
  synced: [] as { appBlockId: string; itemKey: string; level: number }[],
}));

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
}));
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
// Two image keys, as an app stores public image urls in its data.
const IMG_R = '11111111-2222-4333-8444-555555555555';
const IMG_UNSCANNED = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const imageUrl = (key: string) => `https://image.example/abc/${key}/width=450/${key}.jpeg`;

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
  h.levelsOn.clear();
  dbMock.dbRead.appBlock.findUnique.mockImplementation((async () => ({
    manifest: MANIFEST,
  })) as never);
  dbMock.dbRead.image.findMany.mockImplementation((async (args: {
    where: { url: { in: string[] } };
  }) =>
    [
      { url: IMG_R, nsfwLevel: 4, ingestion: 'Scanned' },
      { url: IMG_UNSCANNED, nsfwLevel: 0, ingestion: 'Pending' },
    ].filter((r) => args.where.url.in.includes(r.url))) as never);
  dbMock.dbWrite.entityModeration.findMany.mockImplementation((async () => []) as never);
  dbMock.dbWrite.entityModeration.findUnique.mockImplementation((async () => null) as never);
});

async function ratingOf(app: string, key: string) {
  const [row] = await harness.raw(
    `SELECT d.level, d.rating_status, d.rated_version, d.rating_id FROM appdata.doc d
     WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = 'board' AND d.key = $3`,
    [app, NS_PROD, key]
  );
  return row;
}

/** The scan's callback for `ratingId`, with a verdict of `level` for the text it scanned. */
async function callback(ratingId: number, level: number, scannedTextHash?: string) {
  const subject = (await loadAppDocSubjects([ratingId])).get(ratingId)!;
  const outcome: TextScanOutcome = {
    nsfw: { detectedLevel: level, declaredLevel: 0, raised: level > 1, reason: 'test' },
    nsfwLevel: level,
    triggeredLabels: [],
  };
  return applyAppDocTextScan({
    outcome,
    subject,
    textHash: scannedTextHash ?? textScanTextHash(subject),
  });
}

describe('a pass submits each unrated shared document’s text scan under its rating id', () => {
  it('the scan reads every string value and key of the document', async () => {
    const app = freshApp('RSVSUB');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { title: 'hello', tags: { blue: 1 } });
    const out = await rateUnratedDocs([app]);
    expect(out).toMatchObject({ ready: true, apps: 1, read: 1, acted: 1, submitted: 1 });
    const { rating_id: id } = await ratingOf(app, 'b1');
    expect(h.scans).toEqual([{ entityType: 'AppDoc', entityId: id }]);
    const subject = (await loadAppDocSubjects([id])).get(id)!;
    expect(subject.fields[0].text.split('\n').sort()).toEqual(['blue', 'hello', 'tags', 'title']);
    expect(subject.userId).toBe(AUTHOR);
    // Nothing is rated until the verdict arrives.
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });

  it('a document whose scan is in flight is not resubmitted', async () => {
    const app = freshApp('RSVFLIGHT');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'x' });
    await rateUnratedDocs([app]);
    const { rating_id: id } = await ratingOf(app, 'b1');
    dbMock.dbWrite.entityModeration.findMany.mockImplementation((async () => [
      { entityId: id },
    ]) as never);
    h.scans.length = 0;
    const out = await rateUnratedDocs([app]);
    expect(out).toMatchObject({ read: 1, acted: 0, waiting: 1 });
    expect(h.scans).toEqual([]);
  });

  it('pages past documents still waiting, so they never starve the ones behind them', async () => {
    const app = freshApp('RSVPAGE');
    for (let i = 0; i < 3; i++) await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, `k${i}`, { i });
    const out = await rateUnratedDocs([app], { perPass: 2 });
    expect(out).toMatchObject({ acted: 2, submitted: 2 });
    expect((await ratingOf(app, 'k2')).rating_id).toBeNull();
  });
});

describe('🔴 the callback rates the document', () => {
  it('as the higher of its text and its images, recorded for its current version, and its card follows', async () => {
    const app = freshApp('RSVMAX');
    // Text rated PG-13 (2); it references an image rated R (4): the document is R.
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { pic: imageUrl(IMG_R), t: 'v1' });
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { pic: imageUrl(IMG_R), t: 'v2' });
    await rateUnratedDocs([app]);
    const { rating_id: id } = await ratingOf(app, 'b1');
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
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { pic: imageUrl(IMG_R) });
    await rateUnratedDocs([app]);
    const { rating_id: id } = await ratingOf(app, 'b1');
    expect(await callback(id, 16)).toEqual({ status: 'rated', level: 16 });
  });

  it('🔴 a verdict for text the document no longer has is dropped; the document stays pending', async () => {
    const app = freshApp('RSVSTALE');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'scanned text' });
    await rateUnratedDocs([app]);
    const { rating_id: id } = await ratingOf(app, 'b1');
    const scanned = textScanTextHash((await loadAppDocSubjects([id])).get(id)!);
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'edited before the verdict' });
    expect(await callback(id, 1, scanned)).toEqual({ status: 'stale' });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
    expect(h.synced).toEqual([]);
  });

  it('an image not rated yet leaves it pending', async () => {
    const app = freshApp('RSVMEDIA');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { pic: imageUrl(IMG_UNSCANNED) });
    await rateUnratedDocs([app]);
    const { rating_id: id } = await ratingOf(app, 'b1');
    expect(await callback(id, 1)).toEqual({ status: 'media-pending' });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });
});

describe('without a submit: a stored verdict for the same text, or no text', () => {
  it('🔴 an unchanged text is rated from its stored active verdict', async () => {
    const app = freshApp('RSVSAME');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'same' });
    h.scanResult = { status: 'skipped', reason: 'unchanged' };
    dbMock.dbWrite.entityModeration.findUnique.mockImplementation((async () => ({
      status: 'Succeeded',
      nsfwLevel: 8,
    })) as never);
    const out = await rateUnratedDocs([app]);
    expect(out).toMatchObject({ rated: 1 });
    expect((await ratingOf(app, 'b1')).level).toBe(8);
  });

  it('in shadow a stored verdict rates nothing', async () => {
    const app = freshApp('RSVSHADOW');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { t: 'same' });
    h.scanResult = { status: 'skipped', reason: 'unchanged' };
    h.mode = 'shadow';
    dbMock.dbWrite.entityModeration.findUnique.mockImplementation((async () => ({
      status: 'Succeeded',
      nsfwLevel: 8,
    })) as never);
    expect(await rateUnratedDocs([app])).toMatchObject({ rated: 0, skipped: 1 });
    expect((await ratingOf(app, 'b1')).level).toBeNull();
  });

  it('a text too short to scan rates PG (images can still raise it)', async () => {
    const app = freshApp('RSVEMPTY');
    await store.put(ctx(app, NS_PROD, AUTHOR), BOARD, 'b1', { n: 1 });
    h.scanResult = { status: 'skipped', reason: 'too-short' };
    expect(await rateUnratedDocs([app])).toMatchObject({ rated: 1 });
    expect((await ratingOf(app, 'b1')).level).toBe(1);
  });

  it('the text scan off (kill switch or rollout) rates nothing: the document stays pending', async () => {
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
