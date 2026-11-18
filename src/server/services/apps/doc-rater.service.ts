/**
 * CONTENT LEVELS, build 3: THE RATER for App Blocks shared documents.
 *
 * A shared document's level is the higher of two parts:
 * - its TEXT, rated by the platform text scan as the entity type `AppDoc`
 *   (`text-scan/profiles/app-doc.profile.ts`): every string value and object key in its `data`;
 * - the civitai IMAGES it references, each at its own level (`doc-rating-media.ts`).
 *
 * The text scan is keyed on an integer entity id, so a document gets a RATING ID (`doc.rating_id`,
 * the manual migration `20261118120000_appdata_doc_rating_id.sql`) the first time it is rated. The
 * scan is asynchronous: `rateUnratedDocs` submits it, and the scan's callback calls
 * {@link applyAppDocTextScan}, which rates the document only if its text is still the text that was
 * scanned and binds the rating to the document's revision (`applyRating`).
 *
 * What runs, and when:
 * - The JOB (`app-doc-rater`) rates the unrated shared documents of every app whose levels flag
 *   reads ON (`isSharedDocLevelsKnownOn`; an unreadable flag rates nothing).
 * - The BACKFILL (`/api/admin/temp/app-doc-levels-backfill`) does the same for ONE app whatever its
 *   flag says, so an app's existing documents are rated before its flag is turned on.
 * - The KILL SWITCH and ROLLOUT are the text scan's own: the Flipt `text-scan` switch and the
 *   `AppDoc` rollout in `system:text-scan:modes` (`putModes`). Off, nothing is submitted; in
 *   shadow, verdicts are recorded and nothing is rated; only `active` rates. While a document is
 *   not rated it stays hidden from every viewer but its author, so every way the rater stops
 *   fails closed.
 * - Only the production namespace is rated: a `dev:` or `rev:` namespace is one developer's or
 *   one review's, and its documents stay pending (still visible to their author).
 */
import { NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { isSharedDocLevelsKnownOn } from '~/server/services/apps/doc-levels';
import { docMediaKeys, resolveDocMediaLevel } from '~/server/services/apps/doc-rating-media';
import { PUBLISHED_NS } from '~/server/services/apps/doc-store';
import { declaredCollections } from '~/server/services/apps/doc-store-access';
import { getDocStoreRater } from '~/server/services/apps/doc-store-rater.instance';
import {
  APP_DOC_ENTITY_TYPE,
  appDocTexts,
  appDocTextScanSubject,
  type AppDocSubjectMeta,
} from '~/server/services/apps/doc-rater-subject';
import { syncSubListingRatingFromDoc } from '~/server/services/blocks/app-sub-listing.service';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import { subjectTextLength, textScanTextHash } from '~/server/services/text-scan/prompt';
import { scanEntity } from '~/server/services/text-scan/submit';
import type { TextScanOutcome, TextScanSubject } from '~/server/services/text-scan/types';
import { REMIX_STATUSES } from '~/shared/remix-apps/row.schema';

export type RateResult =
  | { status: 'rated'; level: number }
  | { status: 'media-pending' }
  | { status: 'changed' | 'gone' | 'hidden' | 'counter' };

/**
 * Rate one document at the revision `seq` whose text was rated `textLevel`: the higher of that and
 * its images' levels. Images not rated yet leave it pending. A rated App Store card follows.
 */
export async function rateAppDoc(
  meta: AppDocSubjectMeta,
  data: unknown,
  textLevel: number
): Promise<RateResult> {
  const keys = docMediaKeys(appDocTexts(data));
  if ('overflow' in keys) {
    // More image references than are read per document: never rated on a subset.
    logToAxiom({ name: 'app-doc-rater', type: 'warning', message: 'too many image references' });
    return { status: 'media-pending' };
  }
  const media = await resolveDocMediaLevel(keys.keys);
  if (media.status === 'pending') return { status: 'media-pending' };
  const level = Math.max(textLevel, media.level);
  const applied = await getDocStoreRater().applyRating(
    meta.appId,
    meta.ns,
    meta.collection,
    meta.key,
    { seq: meta.seq, level }
  );
  if (!applied.applied) return { status: applied.reason };
  if (meta.ns === PUBLISHED_NS) {
    await syncSubListingRatingFromDoc({
      appBlockId: meta.appId,
      itemKey: meta.key,
      level: applied.currentLevel,
    });
  }
  return { status: 'rated', level: applied.currentLevel };
}

/** The text level a verdict gives: its nsfw level, PG when the text holds nothing mature. */
export function textLevelOf(outcome: Pick<TextScanOutcome, 'nsfw' | 'nsfwLevel'>): number | null {
  const level = outcome.nsfw?.detectedLevel ?? outcome.nsfwLevel;
  if (level === null || level === undefined || level < NsfwLevel.PG) return null;
  return level;
}

/**
 * The text scan's callback, active verdicts only (`AppDoc` adapter, `applyTextScan`). `subject` is
 * the document as it is NOW; `textHash` is the hash of the text that was scanned. A document whose
 * text changed since is left pending: the next pass scans its new text.
 */
export async function applyAppDocTextScan(args: {
  outcome: TextScanOutcome;
  subject: TextScanSubject;
  textHash: string;
}): Promise<RateResult | { status: 'stale' | 'no-level' }> {
  if (textScanTextHash(args.subject) !== args.textHash) return { status: 'stale' };
  const textLevel = textLevelOf(args.outcome);
  if (textLevel === null) return { status: 'no-level' };
  const meta = args.subject.meta as AppDocSubjectMeta;
  const doc = await getDocStoreRater().getForRating(meta.appId, meta.ns, meta.collection, meta.key);
  if (!doc) return { status: 'gone' };
  // The text matched at load; rate the revision read now, and `applyRating` refuses it if an edit
  // lands in between.
  return rateAppDoc({ ...meta, seq: doc.seq, version: doc.version }, doc.data, textLevel);
}

/** Documents read per page; acted on per pass; read per pass at most. */
export const RATER_PAGE = 50;
export const RATER_PER_PASS = 500;
export const RATER_READ_CAP = 5_000;
/** A submitted scan counts as in flight this long (the text scan's own window). */
const IN_FLIGHT_MS = 30 * 60_000;

export type RatePassResult = {
  ready: boolean;
  apps: number;
  read: number;
  acted: number;
  submitted: number;
  rated: number;
  waiting: number;
  skipped: number;
  failed: number;
};

/** The rating ids among `ids` whose scan was submitted within the in-flight window. */
async function inFlight(ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await dbWrite.entityModeration.findMany({
    where: {
      entityType: { in: [APP_DOC_ENTITY_TYPE, `${APP_DOC_ENTITY_TYPE}:shadow`] },
      entityId: { in: ids },
      status: 'Pending',
      updatedAt: { gte: new Date(Date.now() - IN_FLIGHT_MS) },
    },
    select: { entityId: true },
  });
  return new Set(rows.map((r) => r.entityId));
}

/**
 * Rate one unrated document: give it its rating id, submit its text scan, or rate it straight away
 * when the scan already has a verdict for this exact text (`unchanged`) or there is no text.
 */
async function rateOne(
  appId: string,
  collection: string,
  doc: { key: string; seq: number },
  out: RatePassResult
): Promise<void> {
  const rater = getDocStoreRater();
  const ratingId = await rater.assignRatingId(appId, PUBLISHED_NS, collection, doc.key);
  if (ratingId === null) return void out.skipped++;
  const scan = await scanEntity({ entityType: APP_DOC_ENTITY_TYPE, entityId: ratingId });
  if (scan.status === 'submitted') return void out.submitted++;
  if (scan.status === 'failed') return void out.failed++;
  const now = scan.reason === 'unchanged' || scan.reason === 'too-short';
  if (!now) return void (scan.reason === 'in-flight' ? out.waiting++ : out.skipped++);
  // A verdict for this text is stored (or there is no text): rate now, but only as an ACTIVE
  // verdict would; shadow rates nothing.
  if ((await getTextScanMode(APP_DOC_ENTITY_TYPE, ratingId)) !== 'active')
    return void out.skipped++;
  const current = await rater.getForRating(appId, PUBLISHED_NS, collection, doc.key);
  if (!current) return void out.skipped++;
  const address = { appId, ns: PUBLISHED_NS, collection, key: doc.key };
  const subject = appDocTextScanSubject(address, current);
  let textLevel: number | null = null;
  if (scan.reason === 'too-short') {
    // No text when the scan looked: PG, unless an edit has added text since.
    if (subjectTextLength(subject) === 0) textLevel = NsfwLevel.PG;
  } else {
    const row = await dbWrite.entityModeration.findUnique({
      where: { entityType_entityId: { entityType: APP_DOC_ENTITY_TYPE, entityId: ratingId } },
      select: { status: true, nsfwLevel: true, result: true },
    });
    // The stored verdict counts only for the text it was given for: the document's text now.
    const scannedHash = (row?.result as { textHash?: string } | null)?.textHash;
    if (row?.status === 'Succeeded' && scannedHash === textScanTextHash(subject)) {
      textLevel = textLevelOf({ nsfwLevel: row.nsfwLevel });
    }
  }
  if (textLevel === null) return void out.skipped++;
  const result = await rateAppDoc(
    {
      appId,
      ns: PUBLISHED_NS,
      collection,
      key: doc.key,
      seq: current.seq,
      version: current.version,
    },
    current.data,
    textLevel
  );
  if (result.status === 'rated') out.rated++;
  else if (result.status === 'media-pending') out.waiting++;
  else out.skipped++;
}

/** The shared collections of an app's approved manifest: the ones the levels gate reads. */
async function sharedCollections(appBlockId: string): Promise<string[]> {
  const block = await dbRead.appBlock.findUnique({
    where: { id: appBlockId },
    select: { manifest: true },
  });
  if (!block) return [];
  return [...declaredCollections(appBlockId, block.manifest)]
    .filter(([, decl]) => decl.visibility === 'shared')
    .map(([name]) => name);
}

/**
 * One rating pass over `appIds`: each shared collection's unrated documents, oldest change first,
 * paged by seq so documents still waiting (a scan in flight, an image not rated yet) never starve
 * the ones behind them. Acts on at most `perPass` documents ({@link RATER_PER_PASS}) and reads at
 * most {@link RATER_READ_CAP}. Nothing at all until the rating-id migration is applied (`ready`).
 */
export async function rateUnratedDocs(
  appIds: readonly string[],
  opts: { perPass?: number } = {}
): Promise<RatePassResult> {
  const out: RatePassResult = {
    ready: false,
    apps: 0,
    read: 0,
    acted: 0,
    submitted: 0,
    rated: 0,
    waiting: 0,
    skipped: 0,
    failed: 0,
  };
  const rater = getDocStoreRater();
  if (!(await rater.ready())) return out;
  out.ready = true;
  const budget = opts.perPass ?? RATER_PER_PASS;
  const spent = () => out.acted >= budget || out.read >= RATER_READ_CAP;
  for (const appId of appIds) {
    if (spent()) break;
    out.apps++;
    for (const collection of await sharedCollections(appId)) {
      let afterSeq = 0;
      while (!spent()) {
        const docs = await rater.listUnrated(appId, PUBLISHED_NS, collection, {
          afterSeq,
          limit: RATER_PAGE,
        });
        if (!docs.length) break;
        afterSeq = docs[docs.length - 1].seq;
        out.read += docs.length;
        const waiting = await inFlight(
          docs.map((d) => d.ratingId).filter((id): id is number => id !== null)
        );
        for (const doc of docs) {
          if (out.acted >= budget) break;
          if (doc.ratingId !== null && waiting.has(doc.ratingId)) {
            out.waiting++;
            continue;
          }
          out.acted++;
          try {
            await rateOne(appId, collection, doc, out);
          } catch (error) {
            out.failed++;
            logToAxiom({
              name: 'app-doc-rater',
              type: 'error',
              message: 'rating a document threw',
              appId,
              error: (error as Error).message,
            });
          }
        }
        if (docs.length < RATER_PAGE) break;
      }
    }
  }
  return out;
}

/**
 * How many of one app's shared documents are not rated for their current version, read up to
 * {@link RATER_READ_CAP} (`capped` when there may be more). Rates nothing.
 */
export async function countUnratedDocs(
  appBlockId: string
): Promise<{ ready: boolean; collections: number; unrated: number; capped: boolean }> {
  const rater = getDocStoreRater();
  if (!(await rater.ready())) return { ready: false, collections: 0, unrated: 0, capped: false };
  const collections = await sharedCollections(appBlockId);
  let unrated = 0;
  for (const collection of collections) {
    let afterSeq = 0;
    while (unrated < RATER_READ_CAP) {
      const docs = await rater.listUnrated(appBlockId, PUBLISHED_NS, collection, {
        afterSeq,
        limit: RATER_PAGE,
      });
      unrated += docs.length;
      if (docs.length < RATER_PAGE) break;
      afterSeq = docs[docs.length - 1].seq;
    }
  }
  return {
    ready: true,
    collections: collections.length,
    unrated: Math.min(unrated, RATER_READ_CAP),
    capped: unrated >= RATER_READ_CAP,
  };
}

/** Every on-platform app whose levels flag reads ON: the job's apps. */
export async function appsWithLevelsOn(): Promise<string[]> {
  const blocks = await dbRead.appBlock.findMany({
    where: { externalUrl: null, status: { notIn: REMIX_STATUSES } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const on: string[] = [];
  for (const { id } of blocks) if (await isSharedDocLevelsKnownOn(id)) on.push(id);
  return on;
}
