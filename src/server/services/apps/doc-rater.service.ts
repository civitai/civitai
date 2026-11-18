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
import { TEXT_MODERATION_RETRY_LIMIT } from '~/server/jobs/text-moderation-retry.constants';
import { logToAxiom } from '~/server/logging/client';
import { isSharedDocLevelsKnownOn } from '~/server/services/apps/doc-levels';
import { docMediaKeys, resolveDocMediaLevel } from '~/server/services/apps/doc-rating-media';
import { PUBLISHED_NS, type UnratedDoc } from '~/server/services/apps/doc-store';
import { declaredCollections } from '~/server/services/apps/doc-store-access';
import { getDocStoreRater } from '~/server/services/apps/doc-store-rater.instance';
import {
  APP_DOC_ENTITY_TYPE,
  appDocFields,
  type AppDocSubjectMeta,
} from '~/server/services/apps/doc-rater-subject';
import { syncSubListingRatingFromDoc } from '~/server/services/blocks/app-sub-listing.service';
import {
  getTextScanMode,
  isTextScanEnabled,
  readTextScanRollouts,
  textScanEmEntityType,
} from '~/server/services/text-scan/mode';
import {
  getTextScanConfig,
  subjectTextLength,
  textScanTextHash,
} from '~/server/services/text-scan/prompt';
import { composeUserText } from '~/server/services/text-scan/segment';
import { scanEntity } from '~/server/services/text-scan/submit';
import type {
  TextScanField,
  TextScanOutcome,
  TextScanSubject,
} from '~/server/services/text-scan/types';
import { REMIX_STATUSES } from '~/shared/remix-apps/row.schema';

export type RateResult =
  | { status: 'rated'; level: number }
  | { status: 'media-pending' }
  | { status: 'changed' | 'gone' | 'hidden' | 'counter' };

/** A document's texts, line by line: where its image references are looked for. */
function lines(fields: readonly TextScanField[]): string[] {
  return fields.flatMap((f) => (f.text ?? '').split('\n'));
}

/**
 * Rate one document at the revision `meta.seq`, whose text (`fields`) was rated `textLevel`: the
 * higher of that and its images' levels. Images not rated yet leave it pending. A revision the
 * document has left is refused (`changed`). A rated App Store card follows.
 */
export async function rateAppDoc(
  meta: AppDocSubjectMeta,
  fields: readonly TextScanField[],
  textLevel: number
): Promise<RateResult> {
  const keys = docMediaKeys(lines(fields));
  if ('overflow' in keys) {
    // More image references than are read per document: never rated on a subset.
    logToAxiom({ name: 'app-doc-rater', type: 'warning', message: 'too many image references' });
    return { status: 'media-pending' };
  }
  const media = await resolveDocMediaLevel(keys.keys, keys.urlKeys);
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
 * the document as the callback loaded it; `textHash` is the hash of the text that was scanned. The
 * rating is bound to the revision that subject was loaded at (`subject.meta.seq`), so an edit at any
 * point after the load drops it (`changed`), and a document whose text changed before the load is
 * left pending (`stale`): either way the next pass scans its new text.
 *
 * A text too long to be scanned in one call is never rated from a verdict: a verdict on it may
 * cover only part of it (a cut input, or the partial verdict of a failed multi-segment scan).
 */
export async function applyAppDocTextScan(args: {
  outcome: TextScanOutcome;
  subject: TextScanSubject;
  textHash: string;
}): Promise<RateResult | { status: 'stale' | 'no-level' | 'too-long' }> {
  if (textScanTextHash(args.subject) !== args.textHash) return { status: 'stale' };
  const textLevel = textLevelOf(args.outcome);
  if (textLevel === null) return { status: 'no-level' };
  if (await tooLongForOneCall(args.subject.fields)) return { status: 'too-long' };
  return rateAppDoc(args.subject.meta as AppDocSubjectMeta, args.subject.fields, textLevel);
}

/**
 * Whether the text the scan composes from `fields` (headings included) is longer than one scan
 * call reads: a verdict on it may then cover only part of it, so none is applied.
 */
async function tooLongForOneCall(fields: TextScanField[]): Promise<boolean> {
  const { maxInputChars } = await getTextScanConfig();
  return composeUserText({ fields, declared: {} }).length > maxInputChars;
}

/** Documents read per page; scans submitted per pass; documents read per pass at most. */
export const RATER_PAGE = 50;
export const RATER_PER_PASS = 500;
export const RATER_READ_CAP = 5_000;
/** How often the job runs: the app order rotates by one each period. */
const RATER_PERIOD_MS = 5 * 60_000;

/**
 * Where the next pass resumes in each collection (`<app>/<coll>` → seq), so a collection with more
 * waiting documents than one pass reads does not hold the ones behind them back forever. Kept in
 * this process only: a pass on another process starts from the beginning, and a cursor past the
 * end wraps to it.
 */
const resumeAfter = new Map<string, number>();

export type RatePassResult = {
  ready: boolean;
  apps: number;
  read: number;
  /** Scans submitted (or attempted): what the per-pass budget counts. */
  acted: number;
  submitted: number;
  rated: number;
  waiting: number;
  skipped: number;
  failed: number;
};

type ScanRow = {
  entityType: string;
  entityId: number;
  status: string;
  retryCount: number;
  nsfwLevel: number | null;
  result: unknown;
};

/** The live and shadow verdict rows of these rating ids, by `<row entity type>:<id>`. */
async function scanRows(ids: number[]): Promise<Map<string, ScanRow>> {
  if (!ids.length) return new Map();
  // primary: a scan submitted moments ago must read as owned, or a lagging replica would make the pass resubmit it
  const rows = await dbWrite.entityModeration.findMany({
    where: {
      entityType: {
        in: [APP_DOC_ENTITY_TYPE, textScanEmEntityType(APP_DOC_ENTITY_TYPE, 'shadow')],
      },
      entityId: { in: ids },
    },
    select: {
      entityType: true,
      entityId: true,
      status: true,
      retryCount: true,
      nsfwLevel: true,
      result: true,
    },
  });
  return new Map(rows.map((r) => [`${r.entityType}:${r.entityId}`, r as ScanRow]));
}

const scannedHashOf = (row: ScanRow | undefined) =>
  (row?.result as { textHash?: string } | null | undefined)?.textHash;

/**
 * A scan the pipeline still owns: submitted and not answered, or failed with retries left. The
 * retry job resubmits those (reading the document's text at that time), so a pass must not: it
 * would bill a second workflow and reset the retry budget.
 */
const owned = (row: ScanRow | undefined) =>
  !!row && row.status !== 'Succeeded' && row.retryCount < TEXT_MODERATION_RETRY_LIMIT;

/**
 * One document of a pass. Cheap paths first, from the verdict rows read for the whole page:
 * - a scan the pipeline owns: wait;
 * - an ACTIVE verdict stored for exactly its current text: rate it now;
 * - a SHADOW verdict stored for exactly its current text: nothing to do until the rollout changes.
 * Otherwise give it a rating id and submit its scan (`scanEntity`), the one step the budget counts.
 */
async function rateDoc(
  appId: string,
  collection: string,
  doc: UnratedDoc,
  rows: Map<string, ScanRow>,
  out: RatePassResult
): Promise<void> {
  const meta: AppDocSubjectMeta = {
    appId,
    ns: PUBLISHED_NS,
    collection,
    key: doc.key,
    seq: doc.seq,
    version: doc.version,
  };
  const fields = appDocFields(doc.data);
  const hash = textScanTextHash({ fields, declared: {} });
  const id = doc.ratingId;
  if (id !== null) {
    const mode = await getTextScanMode(APP_DOC_ENTITY_TYPE, id);
    if (mode === 'off') return void out.skipped++;
    // Only the row of the CURRENT mode: the retry job retries a row only while its mode is current,
    // so a shadow row left failed when the rollout moved to active is no one's to wait for.
    const row = rows.get(`${textScanEmEntityType(APP_DOC_ENTITY_TYPE, mode)}:${id}`);
    if (owned(row)) return void out.waiting++;
    if (row?.status === 'Succeeded' && scannedHashOf(row) === hash) {
      // A verdict for exactly this text: rate it if active; in shadow there is nothing to do.
      if (mode !== 'active') return void out.skipped++;
      const level = textLevelOf({ nsfwLevel: row.nsfwLevel });
      if (level === null || (await tooLongForOneCall(fields))) return void out.skipped++;
      return count(await rateAppDoc(meta, fields, level), out);
    }
  }
  out.acted++;
  const ratingId =
    id ?? (await getDocStoreRater().assignRatingId(appId, PUBLISHED_NS, collection, doc.key));
  if (ratingId === null) return void out.skipped++;
  const scan = await scanEntity({ entityType: APP_DOC_ENTITY_TYPE, entityId: ratingId });
  if (scan.status === 'submitted') return void out.submitted++;
  if (scan.status === 'failed') return void out.failed++;
  if (scan.reason === 'in-flight') return void out.waiting++;
  // No text to scan (`too-short`) rates PG, raised by its images, but only as an ACTIVE verdict
  // would, and only while this read's text is still empty (`rateAppDoc` binds the revision).
  if (scan.reason === 'too-short' && subjectTextLength({ fields, declared: {} }) === 0) {
    if ((await getTextScanMode(APP_DOC_ENTITY_TYPE, ratingId)) !== 'active')
      return void out.skipped++;
    return count(await rateAppDoc(meta, fields, NsfwLevel.PG), out);
  }
  // `unchanged` (a verdict for this text exists): the next pass reads it from the page's rows.
  out.skipped++;
}

function count(result: RateResult, out: RatePassResult) {
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

/** Whether the text scan can scan an `AppDoc` at all: its kill switch, and any rollout share. */
async function appDocScanOn(): Promise<boolean> {
  if (!(await isTextScanEnabled())) return false;
  const rollout = (await readTextScanRollouts())[APP_DOC_ENTITY_TYPE];
  return !!rollout && (rollout.active > 0 || rollout.shadow > 0);
}

/** `items` starting at a position that moves by one every job period. */
function rotated<T>(items: readonly T[]): T[] {
  if (items.length < 2) return [...items];
  const start = Math.floor(Date.now() / RATER_PERIOD_MS) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/**
 * One rating pass over `appIds`: each shared collection's unrated documents, oldest change first,
 * paged by seq. Submits at most `perPass` scans ({@link RATER_PER_PASS}) and reads at most
 * {@link RATER_READ_CAP} documents. Documents that are only waiting cost a read, never the budget;
 * the app order rotates every period; and a collection resumes where the last pass on this process
 * stopped reading it ({@link resumeAfter}), so documents stuck waiting do not hold back the ones
 * behind them. One app's failure (an unreadable manifest) is logged and the pass moves on. Nothing
 * at all until the rating-id migration is applied (`ready`), or while the text scan cannot scan
 * `AppDoc`.
 */
export async function rateUnratedDocs(
  appIds: readonly string[],
  opts: {
    perPass?: number;
    /** Throws when the job running the pass was canceled; asked before each page. */
    checkIfCanceled?: () => void;
  } = {}
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
  if (!(await appDocScanOn())) return out;
  const budget = opts.perPass ?? RATER_PER_PASS;
  const canScan = () => out.acted < budget;
  let canceled = false;
  for (const appId of rotated(appIds)) {
    if (!canScan() || out.read >= RATER_READ_CAP) break;
    out.apps++;
    try {
      for (const collection of await sharedCollections(appId)) {
        const cursorKey = `${appId}/${collection}`;
        let afterSeq = resumeAfter.get(cursorKey) ?? 0;
        let wrapped = afterSeq === 0;
        while (canScan() && out.read < RATER_READ_CAP) {
          try {
            opts.checkIfCanceled?.();
          } catch (error) {
            canceled = true;
            throw error;
          }
          const docs = await rater.listUnrated(appId, PUBLISHED_NS, collection, {
            afterSeq,
            limit: RATER_PAGE,
          });
          if (!docs.length) {
            // The end: start again from the beginning, once.
            resumeAfter.delete(cursorKey);
            if (wrapped) break;
            wrapped = true;
            afterSeq = 0;
            continue;
          }
          out.read += docs.length;
          const rows = await scanRows(
            docs.map((d) => d.ratingId).filter((id): id is number => id !== null)
          );
          for (const doc of docs) {
            // The budget is spent: resume at this document next pass.
            if (!canScan()) break;
            try {
              await rateDoc(appId, collection, doc, rows, out);
            } catch (error) {
              out.failed++;
              logToAxiom({
                name: 'app-doc-rater',
                type: 'error',
                message: 'rating a document threw',
                appId,
                payload: { error: (error as Error).message },
              });
            }
            afterSeq = doc.seq;
          }
          resumeAfter.set(cursorKey, afterSeq);
          if (!canScan()) break;
          if (docs.length < RATER_PAGE) {
            resumeAfter.delete(cursorKey);
            break;
          }
        }
      }
    } catch (error) {
      // A canceled job ends the pass; anything else ends only this app.
      if (canceled) throw error;
      out.failed++;
      logToAxiom({
        name: 'app-doc-rater',
        type: 'error',
        message: 'rating an app threw',
        appId,
        payload: { error: (error as Error).message },
      });
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
