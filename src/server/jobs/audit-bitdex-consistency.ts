import { Prisma } from '@prisma/client';
import type { BitdexDocument } from '~/server/bitdex/client';
import { fetchBitdexDocuments } from '~/server/bitdex/client';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import {
  bitdexAuditCheckedCounter,
  bitdexAuditComparedCounter,
  bitdexAuditOpportunityCounter,
  bitdexAuditStratumFailedCounter,
  bitdexAuditErrorsCounter,
  bitdexAuditMismatchCounter,
  bitdexAuditRunDurationHistogram,
  bitdexAuditRunsCounter,
} from '~/server/prom/client';
import { createJob } from './job';

// Standing PG <-> BitDex consistency audit.
//
// The 2026-08-06 leak (~2,300 scheduled images surfaced at feed tops) was invisible
// to every existing signal because BitDex was internally consistent about wrong data:
// its own counters, its verifier, and its query results all agreed with each other.
// Only a comparison against the other system can catch that class, so this job samples
// PG truth and asks BitDex what it holds for the same images.
//
// This job is READ-ONLY. It never emits ops and never heals — healing is the
// re-emitter's job (reemit-bitdex-ops). Keeping the detector separate from the healer
// is deliberate: a detector that repairs what it finds reports zero and hides the rate.

const CADENCE_CRON = '*/10 * * * *';
const BITDEX_INDEX = 'civitai';

const DEFAULT_SAMPLE_SIZE = 50;
// Recency window for stratum B. Wide enough to hold several re-emitter windows, so a
// missed write that the re-emitter is about to heal is still visible to one audit run.
const DEFAULT_PUBLISHED_WINDOW_SECS = 24 * 60 * 60;
// sortAt is derived (GREATEST of publishedAt/scannedAt/createdAt) and lands in BitDex
// through an async pipeline, so exact equality would flag ordinary propagation lag.
// Only a drift larger than this is a real disagreement about the value.
const DEFAULT_SORTAT_TOLERANCE_SECS = 5 * 60;

// A freshly (un)published post is mid-flight through the sync pipeline; comparing it
// would measure propagation lag, not correctness. Same reasoning as the re-emitter's
// settle belt, and deliberately larger — the audit has no reason to look at the edge.
const DEFAULT_SETTLE_SECS = 120;

// Stratum C's belt, and it is wider than the others for a reason that is NOT caution.
// The other two compare publication state, which lives on `Post`, so `Post."updatedAt"`
// moves with the thing they measure. This one compares a value derived from
// `ImageResourceNew`, which `addResourceToImages` (post.service.ts) writes without
// touching `Post."updatedAt"` — so the query bounds `Image."updatedAt"` as well.
//
// ⚠️ That is a reduction, NOT a closure, and the residual is the same order of magnitude
// as the false-mismatch class this stratum's comparison rule was written to remove.
// Measured on the prod replica over this stratum's population (posts published in the
// last 24h, past a 15-minute belt): 90.2% of images carry an `Image."updatedAt"` later
// than their post's, and 0.28% were modified INSIDE the belt window. `ImageResourceNew`
// carries no timestamp of its own, so a resource edit that moves neither row is
// unbounded and unmeasurable after the fact. A mismatch on a just-edited image is a
// known false positive here; the row prints both sides so it can be recognised as one.
const DEFAULT_BASEMODEL_SETTLE_SECS = 15 * 60;

// Doc fields the comparison reads.
//
// ⚠️ `publishedAt` is requested and is NOT a field of the MEILI document: the metrics indexer
// destructures it out of the record and emits `publishedAtUnix` instead
// (metrics-images.search-index.ts). So the "publishedAt carries the same fact if the
// boolean is missing" fallback this list used to claim is inert, and `sortAt` is the
// only independent witness that a document exists at all. Keep `sortAt` in every field
// list for that reason.
//
// `publishedAt` stays too: these strata read BITDEX documents, and BitDex's document
// shape is not in this repo, so the Meili evidence above does not establish that the key
// is absent there. Requesting a field that does not exist costs nothing; dropping one
// that does would silently remove a witness.
const AUDIT_DOC_FIELDS = ['id', 'isPublished', 'publishedAt', 'sortAt'];

// The baseModel stratum needs the publication fields too, because a document that is
// absent or unpublished is not compared here — and it needs `sortAt` for the reason
// above: without it, presence would rest on `isPublished` alone, and a projection that
// omitted that one key would skip every row and report a clean stratum.
const BASEMODEL_DOC_FIELDS = ['id', 'isPublished', 'publishedAt', 'sortAt', 'baseModel'];

// Cap on mismatch rows written to Axiom per run. The counters carry the rate; the log
// only has to carry enough ids to start an investigation.
const MAX_LOGGED_MISMATCHES = 25;

export type AuditStratum = 'scheduled' | 'published_recent' | 'basemodel';
export type MismatchKind =
  | 'scheduled_visible'
  | 'published_missing'
  | 'sortat_drift'
  | 'basemodel_not_checkpoint'
  | 'basemodel_missing'
  | 'basemodel_unfilterable';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type AuditConfig = {
  sampleSize: number;
  publishedWindowSecs: number;
  sortAtToleranceSecs: number;
  settleSecs: number;
  baseModelSettleSecs: number;
};

// Env-overridable so sample size and tolerance can be retuned without a redeploy —
// the same pattern the re-emitter uses for its window.
export function getAuditConfig(): AuditConfig {
  return {
    sampleSize: parsePositiveInt(process.env.BITDEX_AUDIT_SAMPLE_SIZE, DEFAULT_SAMPLE_SIZE),
    publishedWindowSecs: parsePositiveInt(
      process.env.BITDEX_AUDIT_PUBLISHED_WINDOW_SECS,
      DEFAULT_PUBLISHED_WINDOW_SECS
    ),
    sortAtToleranceSecs: parsePositiveInt(
      process.env.BITDEX_AUDIT_SORTAT_TOLERANCE_SECS,
      DEFAULT_SORTAT_TOLERANCE_SECS
    ),
    settleSecs: parsePositiveInt(process.env.BITDEX_AUDIT_SETTLE_SECS, DEFAULT_SETTLE_SECS),
    baseModelSettleSecs: parsePositiveInt(
      process.env.BITDEX_AUDIT_BASEMODEL_SETTLE_SECS,
      DEFAULT_BASEMODEL_SETTLE_SECS
    ),
  };
}

// One sampled image, carrying PG's answer for everything the comparison checks.
export type AuditSampleRow = {
  imageId: number;
  postId: number;
  // Post publish time, epoch seconds. Always in the future for the scheduled stratum.
  publishedAtSecs: number;
  // What BitDex's sortAt should hold for this image: GREATEST(publishedAt, scannedAt,
  // createdAt) in epoch seconds — the same expression the index config computes from
  // publishedAt and existedAt (= max(scannedAt, createdAt)). Computed in PG so the
  // audit compares against the same GREATEST semantics rather than reimplementing them.
  expectedSortAtSecs: number;
  // Distinct baseModels of the image's CHECKPOINT resources. Only the baseModel stratum
  // selects it, which is why the type says optional — but it is REQUIRED wherever it is
  // read, and `auditStratum` throws rather than defaulting when a sampled row arrives
  // without it. Coercing a lost column to `[]` would mean "this image has no checkpoint",
  // which is a legitimate state for ~14% of images and would silence both arms while the
  // denominators still looked healthy.
  expectedBaseModels?: string[] | null;
};

// Stratum A — the incident class. Images whose parent Post is scheduled to publish in
// the FUTURE: BitDex must not hold these as published. `ORDER BY random()` over a set
// this size (~94K images as of 2026-08-06) is cheap and, unlike a fixed ordering,
// makes repeated runs cover the population instead of re-checking the same head.
export function buildScheduledSampleQuery({
  sampleSize,
  settleSecs,
}: Pick<AuditConfig, 'sampleSize' | 'settleSecs'>): Prisma.Sql {
  return Prisma.sql`
    SELECT
      i.id AS "imageId",
      p.id AS "postId",
      extract(epoch FROM p."publishedAt")::double precision AS "publishedAtSecs",
      extract(epoch FROM GREATEST(p."publishedAt", i."scannedAt", i."createdAt"))::double precision
        AS "expectedSortAtSecs"
    FROM "Post" p
    JOIN "Image" i ON i."postId" = p.id
    WHERE p."publishedAt" > now()
      AND p."updatedAt" < now() - make_interval(secs => ${settleSecs})
    ORDER BY random()
    LIMIT ${sampleSize}
  `;
}

// Stratum B — the inverse failure. Images whose parent Post published recently: BitDex
// must hold these as published, with a sortAt that agrees with PG. Catches a dropped
// publish (content that never became visible), which is the same lost-write class as
// the incident pointing the other way.
export function buildPublishedSampleQuery({
  sampleSize,
  publishedWindowSecs,
  settleSecs,
}: Pick<AuditConfig, 'sampleSize' | 'publishedWindowSecs' | 'settleSecs'>): Prisma.Sql {
  return Prisma.sql`
    SELECT
      i.id AS "imageId",
      p.id AS "postId",
      extract(epoch FROM p."publishedAt")::double precision AS "publishedAtSecs",
      extract(epoch FROM GREATEST(p."publishedAt", i."scannedAt", i."createdAt"))::double precision
        AS "expectedSortAtSecs"
    FROM "Post" p
    JOIN "Image" i ON i."postId" = p.id
    WHERE p."publishedAt" > now() - make_interval(secs => ${publishedWindowSecs})
      AND p."publishedAt" <= now()
      AND p."updatedAt" < now() - make_interval(secs => ${settleSecs})
    ORDER BY random()
    LIMIT ${sampleSize}
  `;
}

// Stratum C — what the two base-model filter reports were about (868ktxe1r, 868ku8x8k).
// BitDex's `baseModel` decides whether an image matches `In(baseModel, [...])`, and the
// two reported failures were the two directions of it being wrong: a value taken from an
// attached LoRA rather than the checkpoint, so a Pony filter served an Illustrious image;
// and no value at all on a fresh document, so a recent image matched no filter.
//
// Truth here is the CHECKPOINT-only derivation, which is what the Meilisearch index
// builds (`CASE WHEN m.type = 'Checkpoint' THEN mv."baseModel"`, metrics-images.search-index.ts).
// An image with no checkpoint resource legitimately has no base model, and that is a
// distinct case rather than a missing one — see `compareStratum`.
export function buildBaseModelSampleQuery({
  sampleSize,
  publishedWindowSecs,
  baseModelSettleSecs,
}: Pick<AuditConfig, 'sampleSize' | 'publishedWindowSecs' | 'baseModelSettleSecs'>): Prisma.Sql {
  return Prisma.sql`
    SELECT
      i.id AS "imageId",
      p.id AS "postId",
      extract(epoch FROM p."publishedAt")::double precision AS "publishedAtSecs",
      extract(epoch FROM GREATEST(p."publishedAt", i."scannedAt", i."createdAt"))::double precision
        AS "expectedSortAtSecs",
      -- WARNING: safe by planner grace, not by construction. A correlated subquery in the
      -- target list, under a random sort, is the shape Postgres can evaluate once per INPUT
      -- row. Measured on the replica: Result -> Sort -> Gather with the SubPlan at loops=50,
      -- because the projection is postponed above the top-N heapsort — 2,826 buffers, not
      -- the ~81,700 executions the shape allows. Move this value into a filter, a sort key
      -- or a de-duplication and it drops below the Sort; that version takes ~60s per run on
      -- the primary, every 10 minutes.
      --
      -- Deliberately worded without the SQL keywords the builder's tests assert on: a
      -- comment repeating them would satisfy those substring checks on its own.
      COALESCE((
        SELECT array_agg(DISTINCT mv."baseModel")
        FROM "ImageResourceNew" irn
        JOIN "ModelVersion" mv ON mv.id = irn."modelVersionId"
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE irn."imageId" = i.id AND m.type = 'Checkpoint' AND mv."baseModel" IS NOT NULL
      ), '{}') AS "expectedBaseModels"
    FROM "Post" p
    JOIN "Image" i ON i."postId" = p.id
    WHERE p."publishedAt" > now() - make_interval(secs => ${publishedWindowSecs})
      AND p."publishedAt" <= now()
      AND p."updatedAt" < now() - make_interval(secs => ${baseModelSettleSecs})
      AND i."updatedAt" < now() - make_interval(secs => ${baseModelSettleSecs})
    ORDER BY random()
    LIMIT ${sampleSize}
  `;
}

export type BitdexDocState = {
  // False when BitDex returned no row, or a bare `{ id }` — the batch endpoint's
  // encoding for "no document on disk for this slot".
  present: boolean;
  published: boolean;
  sortAtSecs: number | null;
  // Empty string is the index's own "no checkpoint" encoding — the Meili side builds the
  // value with `string_agg`, which yields '' rather than null when nothing matches. Both
  // spellings mean the same thing here, so they collapse to null.
  baseModel: string | null;
};

// Reads BitDex's answer out of a doc payload.
//
// ⚠️ `publishedAt` reads like a fallback and is NOT one: the metrics indexer destructures
// it out of the record and emits `publishedAtUnix`, so it is never a document field. That
// leaves `published` resting on `isPublished` alone. `present` has `sortAt` as a second
// witness; `published` has none, so a projection that omits `isPublished` reports every
// document unpublished rather than reporting nothing.
export function readDocState(doc: BitdexDocument | undefined): BitdexDocState {
  if (!doc) return { present: false, published: false, sortAtSecs: null, baseModel: null };

  const isPublished = doc.isPublished;
  const publishedAt = doc.publishedAt;
  const sortAt = doc.sortAt;
  const baseModel = doc.baseModel;
  const present = isPublished !== undefined || publishedAt !== undefined || sortAt !== undefined;

  return {
    present,
    published: typeof isPublished === 'boolean' ? isPublished : publishedAt != null,
    sortAtSecs: typeof sortAt === 'number' ? sortAt : null,
    baseModel: typeof baseModel === 'string' && baseModel !== '' ? baseModel : null,
  };
}

/**
 * Is the document's baseModel explainable by the image's checkpoints?
 *
 * NOT membership. The index this stratum treats as truth builds the value with
 * `string_agg(..., '')` — no delimiter, no DISTINCT — so a multi-checkpoint image comes
 * back as one glued string (`AnimaMiniMax H3`), and `includes()` would call that a
 * mismatch. Measured on the prod replica over this stratum's exact window: 3000 rows,
 * 2566 single-checkpoint, 427 with none, 7 multi. At 0.23% that is roughly 17 false
 * mismatches a day — a permanent noise floor on the series meant to detect the leak.
 *
 * BitDex's own derivation is the thing we cannot observe from here, so this deliberately
 * does not assume Meili's exact expression: a value is accepted when it can be consumed
 * entirely by concatenating checkpoint base models, in any order, which holds whether the
 * producer emits one value or glues several. A base model belonging to no checkpoint on
 * the image — the reported leak — still cannot be consumed, which is the property that
 * has to survive.
 */
export function baseModelIsExplained(value: string, expected: string[]): boolean {
  if (!expected.length) return false;
  const candidates = [...new Set(expected)].filter(Boolean);

  const seen = new Set<number>();
  const consume = (from: number): boolean => {
    if (from === value.length) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const c of candidates) {
      if (value.startsWith(c, from) && consume(from + c.length)) return true;
    }
    return false;
  };
  return consume(0);
}

export type AuditMismatch = {
  stratum: AuditStratum;
  kind: MismatchKind;
  imageId: number;
  postId: number;
  expected: string;
  actual: string;
};

/**
 * Pure comparison: PG rows in, BitDex docs in, mismatches out. No IO, so the failure
 * classification is testable without a database or a BitDex server — which matters
 * more here than usual, since this logic decides whether an alert fires.
 */
export function compareStratum(
  stratum: AuditStratum,
  rows: AuditSampleRow[],
  docs: BitdexDocument[],
  { sortAtToleranceSecs }: Pick<AuditConfig, 'sortAtToleranceSecs'>
): AuditMismatch[] {
  const byId = new Map<number, BitdexDocument>();
  for (const doc of docs) byId.set(doc.id, doc);

  const mismatches: AuditMismatch[] = [];
  for (const row of rows) {
    const state = readDocState(byId.get(row.imageId));

    if (stratum === 'basemodel') {
      // Not compared. Stratum B samples the same population independently and reports
      // that class in aggregate — it is NOT handed this row, so do not read this as a
      // deferral. It is a skip, which is why the run reports how many rows it actually
      // compared rather than only how many it sampled.
      if (!state.present || !state.published) continue;

      const expected = expectedBaseModelsOf(row);

      if (state.baseModel == null) {
        // No checkpoint on the image means no base model is the CORRECT answer, so this
        // arm can only fire where PG has one. That is also why the run reports how many
        // sampled images had a checkpoint at all — see `baseModelDenominators`.
        if (expected.length) {
          mismatches.push({
            stratum,
            kind: 'basemodel_missing',
            imageId: row.imageId,
            postId: row.postId,
            expected: `one of [${expected.join(', ')}]`,
            actual: 'no baseModel on the document',
          });
        }
        continue;
      }

      if (!baseModelIsExplained(state.baseModel, expected)) {
        mismatches.push({
          stratum,
          kind: 'basemodel_not_checkpoint',
          imageId: row.imageId,
          postId: row.postId,
          expected: expected.length
            ? `one of [${expected.join(', ')}]`
            : 'no baseModel (image has no checkpoint resource)',
          actual: `baseModel=${state.baseModel}`,
        });
        continue;
      }

      // Explainable but not a single checkpoint — a glued value like `AnimaMiniMax H3`.
      // The base-model filter is exact string equality (`_in('baseModel', …)` in
      // image.service.ts), so a glued value matches NO filter: it is 868ku8x8k's symptom
      // arriving by a different route, and accepting it silently is how the previous
      // rule's fix would have hidden a real defect while removing a false one.
      //
      // 🔴 Its own kind on purpose, and NOT an alerting series — but read the reason
      // carefully before trusting the floor. ~0.2% of sampled images have more than one
      // checkpoint (measured in PG), and the MEILI indexer glues those with `string_agg`.
      // Whether BITDEX glues them is unknown: its ingest is not in this repo, which is the
      // whole reason this guard exists, and this file refuses the same cross-system
      // inference elsewhere when it keeps `publishedAt`.
      //
      // So: if BitDex does NOT glue, every row on this kind is a real defect of
      // 868ku8x8k's class, pre-labelled as noise. Whoever flips `bitdex-image-search`
      // should treat a nonzero count here on the first real run as a FINDING until
      // someone confirms BitDex glues the way Meili does. Alert on
      // `basemodel_not_checkpoint` and `basemodel_missing`; watch this one's rate.
      if (!expected.includes(state.baseModel)) {
        mismatches.push({
          stratum,
          kind: 'basemodel_unfilterable',
          imageId: row.imageId,
          postId: row.postId,
          expected: `exactly one of [${expected.join(', ')}]`,
          actual: `baseModel=${state.baseModel} (concatenation; matches no base-model filter)`,
        });
      }
      continue;
    }

    if (stratum === 'scheduled') {
      // A doc that is absent, or present and unpublished, is the correct state — a
      // scheduled post's images are legitimately either not indexed yet or indexed
      // as unpublished. Only "BitDex says published" is the incident signature.
      if (state.published) {
        mismatches.push({
          stratum,
          kind: 'scheduled_visible',
          imageId: row.imageId,
          postId: row.postId,
          expected: `unpublished (PG publishedAt=${row.publishedAtSecs} is in the future)`,
          actual: `isPublished=true, sortAt=${state.sortAtSecs ?? 'null'}`,
        });
      }
      continue;
    }

    if (!state.present || !state.published) {
      mismatches.push({
        stratum,
        kind: 'published_missing',
        imageId: row.imageId,
        postId: row.postId,
        expected: `published (PG publishedAt=${row.publishedAtSecs})`,
        actual: state.present ? 'isPublished=false' : 'document absent',
      });
      continue;
    }

    // Only reached for docs BitDex agrees are published, so a drift here is a
    // disagreement about ordering, not a missing write.
    const drift =
      state.sortAtSecs == null ? null : Math.abs(state.sortAtSecs - row.expectedSortAtSecs);
    if (drift == null || drift > sortAtToleranceSecs) {
      mismatches.push({
        stratum,
        kind: 'sortat_drift',
        imageId: row.imageId,
        postId: row.postId,
        expected: `sortAt~=${row.expectedSortAtSecs} (+/-${sortAtToleranceSecs}s)`,
        actual: `sortAt=${state.sortAtSecs ?? 'null'}${drift == null ? '' : `, drift=${drift}s`}`,
      });
    }
  }

  return mismatches;
}

// The three kinds this stratum can report. Named so the seeding loop and the reader
// cannot drift from the `MismatchKind` union.
// The two arms denominated by documents that CARRY a value. `satisfies` for the same
// reason KINDS_BY_STRATUM has it: an untyped string array here is the one place in this
// file that can drift from `MismatchKind` without a type error.
const VALUE_SIDE_KINDS = [
  'basemodel_not_checkpoint',
  'basemodel_unfilterable',
] as const satisfies readonly MismatchKind[];

// Every stratum's kinds, so the seeding below is not applied to the newest arm alone.
// The reuse lane caught exactly that: the three paragraphs arguing an absent series breaks
// `increase(...) == 0` were true of `scheduled_visible`, `published_missing` and
// `sortat_drift` too, and those were left absent.
const KINDS_BY_STRATUM = {
  scheduled: ['scheduled_visible'],
  published_recent: ['published_missing', 'sortat_drift'],
  basemodel: ['basemodel_not_checkpoint', 'basemodel_missing', 'basemodel_unfilterable'],
} as const satisfies Record<AuditStratum, readonly MismatchKind[]>;

const countUnfilterable = (m: AuditMismatch[]) =>
  m.filter((x) => x.kind === 'basemodel_unfilterable').length;
const countAlerting = (m: AuditMismatch[]) =>
  m.filter((x) => x.kind !== 'basemodel_unfilterable').length;

export type AuditScopeResult = {
  stratum: AuditStratum;
  checked: number;
  mismatches: AuditMismatch[];
  // Only the baseModel stratum sets these. `checked` alone cannot tell a clean run from
  // one that compared nothing: documents that are absent or unpublished are skipped, and
  // the `basemodel_missing` arm can only fire on an image that HAS a checkpoint. A zero
  // beside a zero denominator is not evidence of agreement.
  comparedDocs?: number;
  withCheckpoint?: number;
  // 🔴 `withCheckpoint` and `withDocValue` ARE the per-arm denominators — do not add
  // "opportunity" counts beside them. A previous round did, and `missingArmOpportunities`
  // came out as `hasCheckpoint && !hasValue`, which is the `basemodel_missing` PREDICATE:
  // numerator and denominator identical, ratio permanently 1 or 0/0. The arm can only
  // fire on a document that has a checkpoint, so the denominator is "compared documents
  // WITH a checkpoint" — and the same for the leak arm and `withDocValue`.
  // The `not_checkpoint` arm's own denominator: compared documents that actually carried
  // a value to disagree about. Its zero needs this the way the `missing` arm's zero needs
  // `withCheckpoint`, and one number covering both arms would hide whichever is empty.
  withDocValue?: number;
};

/**
 * Reads the checkpoint set off a sampled row, and THROWS when the column is not there.
 *
 * The tempting `?? []` is the failure this whole guard exists to prevent: an empty set is
 * a legitimate state for ~14% of images (no checkpoint resource), so a lost alias, a
 * dropped COALESCE or a changed row shape would silence BOTH arms permanently while
 * `comparedDocs` stayed healthy and nonzero. Throwing routes it to the error counter and
 * fails the run, which is loud; defaulting would read as a clean audit forever.
 */
export class MissingExpectedBaseModelsError extends Error {}

function expectedBaseModelsOf(row: AuditSampleRow): string[] {
  if (!Array.isArray(row.expectedBaseModels))
    throw new MissingExpectedBaseModelsError(
      `baseModel stratum: image ${row.imageId} arrived without expectedBaseModels — the sample query is not delivering the column`
    );
  return row.expectedBaseModels;
}

/**
 * The denominators the baseModel stratum's zero has to be read against: how many sampled
 * images BitDex held as published documents at all, and how many of those PG says have a
 * checkpoint. Separate from `compareStratum` so both numbers exist whether or not any
 * mismatch was found.
 */
export function baseModelDenominators(rows: AuditSampleRow[], docs: BitdexDocument[]) {
  const byId = new Map<number, BitdexDocument>();
  for (const doc of docs) byId.set(doc.id, doc);

  let comparedDocs = 0;
  let withCheckpoint = 0;
  let withDocValue = 0;
  for (const row of rows) {
    const state = readDocState(byId.get(row.imageId));
    if (!state.present || !state.published) continue;
    comparedDocs++;
    // `basemodel_missing` can only fire on a compared document that HAS a checkpoint;
    // `basemodel_not_checkpoint` and `basemodel_unfilterable` only on one that HAS a
    // value. So these two marginals are the arms' denominators, and a ratio against
    // either is bounded below 1 rather than being the numerator again.
    if (expectedBaseModelsOf(row).length) withCheckpoint++;
    if (state.baseModel != null) withDocValue++;
  }
  return { comparedDocs, withCheckpoint, withDocValue };
}

// Samples one stratum and compares it. A BitDex fetch failure propagates:
// fetchBitdexDocuments throws rather than returning null precisely so an unreachable
// index can never be mistaken for a clean audit.
async function auditStratum(
  stratum: AuditStratum,
  query: Prisma.Sql,
  config: AuditConfig,
  docFields: string[] = AUDIT_DOC_FIELDS
): Promise<AuditScopeResult> {
  try {
    return await auditStratumInner(stratum, query, config, docFields);
  } catch (e) {
    // Labelled at the SOURCE, so it fires however the stratum died — a BitDex outage, a
    // Postgres error on the sample, or the column-shape guard. Incrementing it only in
    // the caller's catch missed every failure the caller rethrows, which is most of them.
    bitdexAuditStratumFailedCounter?.inc({ stratum }, 1);
    throw e;
  }
}

async function auditStratumInner(
  stratum: AuditStratum,
  query: Prisma.Sql,
  config: AuditConfig,
  docFields: string[] = AUDIT_DOC_FIELDS
): Promise<AuditScopeResult> {
  // Primary, not the replica: this job's whole output is "PG and BitDex disagree",
  // and replica lag would manufacture exactly that disagreement. 100 sampled rows
  // every 10 minutes is nothing against the primary, and it removes a false-positive
  // source that would be indistinguishable from the real finding in the metric.
  const rows = await dbWrite.$queryRaw<AuditSampleRow[]>(query);
  if (!rows.length) return { stratum, checked: 0, mismatches: [] };

  const docs = await fetchBitdexDocuments(
    BITDEX_INDEX,
    rows.map((r) => r.imageId),
    docFields
  );

  return {
    stratum,
    checked: rows.length,
    mismatches: compareStratum(stratum, rows, docs, config),
    ...(stratum === 'basemodel' ? baseModelDenominators(rows, docs) : {}),
  };
}

export type AuditResult = {
  scheduled: AuditScopeResult;
  publishedRecent: AuditScopeResult;
  baseModel: AuditScopeResult;
  // Set when the baseModel stratum threw. Its presence is the ONLY thing separating a
  // stratum that failed from one that found nothing, since both report zero mismatches.
  baseModelError?: string;
};

export async function runAudit(config: AuditConfig): Promise<AuditResult> {
  const scheduled = await auditStratum('scheduled', buildScheduledSampleQuery(config), config);
  const publishedRecent = await auditStratum(
    'published_recent',
    buildPublishedSampleQuery(config),
    config
  );
  // Stratum C is caught SEPARATELY. It is the newest and the only one that throws on a
  // column shape, and letting that propagate would discard the two already-computed
  // results — no checked, no mismatch, no runs increment — so a problem in the newest
  // stratum would silence the detector for the 2026-08-06 incident class on every run.
  // The failure is still loud: the error counter fires and the run reports it, but C is
  // marked failed rather than reported as clean.
  let baseModel: AuditScopeResult;
  let baseModelError: string | undefined;
  try {
    baseModel = await auditStratum(
      'basemodel',
      buildBaseModelSampleQuery(config),
      config,
      BASEMODEL_DOC_FIELDS
    );
  } catch (e) {
    // EVERY stratum-C failure is caught, not just the column-shape one. Gating on that
    // single class meant the likelier spelling of the same problem — a renamed column, a
    // missing migration, anything Postgres reports rather than JS — rethrew and discarded
    // the two already-computed results, silencing the detector for the 2026-08-06
    // incident class on every run.
    //
    // This does NOT recreate the silent pass `fetchBitdexDocuments` throws to prevent.
    // The failure is loud on three surfaces: `stratum_failed_total{stratum="basemodel"}`
    // (labelled, incremented at the source), `errors_total`, and `baseModelError` on the
    // run. What it must never do is report zero mismatches with nothing to say — and it
    // does not, because a failed stratum still emits its denominators as zero, and a
    // zero denominator beside a zero numerator is not agreement.
    baseModelError = e instanceof Error ? e.message : String(e);
    // checked stays 0 and the denominators are emitted as zero below — deliberately.
    // An ABSENT series is worse than a zero one: `increase(...) == 0` over a series that
    // does not exist returns an empty vector, so the alert silently never fires.
    baseModel = { stratum: 'basemodel', checked: 0, mismatches: [] };
  }
  return { scheduled, publishedRecent, baseModel, baseModelError };
}

export const auditBitdexConsistency = createJob(
  'audit-bitdex-consistency',
  CADENCE_CRON,
  async () => {
    // Default-off: registered and scheduled but no-ops until the flag is flipped on.
    const enabled = await isFlipt(FLIPT_FEATURE_FLAGS.BITDEX_CONSISTENCY_AUDIT);
    if (!enabled) return;

    const config = getAuditConfig();
    const start = Date.now();
    let result: AuditResult;
    try {
      result = await runAudit(config);
    } catch (e) {
      bitdexAuditErrorsCounter?.inc();
      throw e; // createJob logs job-error to Axiom and marks the run failed
    }
    // A caught stratum failure is still an error: the run continues so the other two
    // strata keep reporting, but it must not look like a clean pass.
    //
    // `errors_total` is unlabelled and shared with whole-run failures, so on its own it
    // cannot say WHICH stratum died — and `runs_total` still ticks, correctly, because
    // the run did complete for the other two. The labelled series is the one an alert
    // can use to notice that this stratum has been dead for a week.
    if (result.baseModelError) bitdexAuditErrorsCounter?.inc();

    const durationSec = (Date.now() - start) / 1000;

    const scopes = [result.scheduled, result.publishedRecent, result.baseModel];
    for (const scope of scopes) {
      bitdexAuditCheckedCounter?.inc({ stratum: scope.stratum }, scope.checked);
      for (const mismatch of scope.mismatches)
        bitdexAuditMismatchCounter?.inc({ stratum: scope.stratum, kind: mismatch.kind }, 1);

      // The denominators go to PROMETHEUS, not only to the Axiom line — an alert reads
      // the series, and `checked_total` counts rows SAMPLED. A row whose document is
      // absent or unpublished is skipped before any comparison, so without these a
      // stratum that compared nothing emits a mismatch zero identical to one from
      // perfect agreement, which is the whole failure this guard exists to prevent.
      //
      // 🔴 Emitted UNCONDITIONALLY, including zero, for the same reason `checked_total`
      // is. prom-client creates a labelled child on first `inc`, so skipping the call
      // when a stratum produced nothing leaves the series ABSENT rather than zero — and
      // `increase(...) == 0` over an absent series returns an empty vector, so the
      // denominator alert never fires. Absence is worse than a flat line: a flat line
      // and a flat line look the same, but absence breaks the query.
      if (scope.stratum === 'basemodel') {
        bitdexAuditComparedCounter?.inc({ stratum: scope.stratum }, scope.comparedDocs ?? 0);
        bitdexAuditOpportunityCounter?.inc(
          { stratum: scope.stratum, kind: 'basemodel_missing' },
          scope.withCheckpoint ?? 0
        );
        // Both value-side arms share this denominator: they can only fire on a compared
        // document that carried a value at all.
        for (const kind of VALUE_SIDE_KINDS)
          bitdexAuditOpportunityCounter?.inc(
            { stratum: scope.stratum, kind },
            scope.withDocValue ?? 0
          );
      }

      // The NUMERATOR needs seeding for the same reason the denominators do, and for EVERY
      // stratum — on a healthy system a kind that has never fired has no series at all, so
      // `increase(...) == 0` returns an empty vector and Grafana renders "No data" rather
      // than "none". Outside the basemodel guard above, because the older strata have the
      // same problem and were left absent.
      for (const kind of KINDS_BY_STRATUM[scope.stratum])
        bitdexAuditMismatchCounter?.inc({ stratum: scope.stratum, kind }, 0);
    }

    bitdexAuditRunsCounter?.inc();
    bitdexAuditRunDurationHistogram?.observe(durationSec);

    const allMismatches = scopes.flatMap((s) => s.mismatches);
    const perStratumCap = Math.ceil(MAX_LOGGED_MISMATCHES / scopes.length);
    const loggedMismatches = scopes.flatMap((s) => s.mismatches.slice(0, perStratumCap));
    const truncatedByStratum = Object.fromEntries(
      scopes.map((s) => [s.stratum, Math.max(0, s.mismatches.length - perStratumCap)])
    );

    // Logged every run, not only on a finding: a run that checked 0 rows is not the
    // same as a run that found nothing wrong, and only the log distinguishes them.
    logToAxiom(
      {
        type: 'job',
        name: 'audit-bitdex-consistency',
        message: 'audit-complete',
        scheduledChecked: result.scheduled.checked,
        scheduledMismatches: result.scheduled.mismatches.length,
        publishedChecked: result.publishedRecent.checked,
        publishedMismatches: result.publishedRecent.mismatches.length,
        baseModelChecked: result.baseModel.checked,
        // The two denominators the baseModel zero must be read against: sampling 50 rows
        // and comparing none of them reports the same mismatch count as full agreement.
        baseModelComparedDocs: result.baseModel.comparedDocs ?? 0,
        baseModelWithCheckpoint: result.baseModel.withCheckpoint ?? 0,
        baseModelWithDocValue: result.baseModel.withDocValue ?? 0,
        // Split, because `basemodel_unfilterable` is expected to be nonzero on a healthy
        // system (~0.2% of sampled images). Folding it into the summary count would put
        // the same permanent floor under the number a human reads that keeping it out of
        // the alerting series was meant to avoid.
        baseModelMismatches: countAlerting(result.baseModel.mismatches),
        baseModelUnfilterable: countUnfilterable(result.baseModel.mismatches),
        // Present only when the stratum threw. Without it a failed stratum and a clean
        // one are the same row of zeros.
        baseModelError: result.baseModelError,
        // Ids and expected-vs-actual, so a firing alert has a trail to pull on
        // instead of only a rate.
        // 🔴 Sliced PER STRATUM, not off one flat list. The strata are logged in order and
        // basemodel is last, so a flat cap is a priority ordering: during the 2026-08-06
        // incident class stratum A alone would fill all 25 rows and NO stratum-C image id
        // would reach the log, while its counter moved and the alert fired. The on-call
        // then has a rate and no evidence, which is what this field exists to prevent.
        mismatches: loggedMismatches,
        mismatchesTruncated: allMismatches.length - loggedMismatches.length,
        mismatchesTruncatedByStratum: truncatedByStratum,
        durationSec,
        sampleSize: config.sampleSize,
        sortAtToleranceSecs: config.sortAtToleranceSecs,
      },
      'webhooks'
    ).catch(() => undefined);

    return {
      scheduledChecked: result.scheduled.checked,
      scheduledMismatches: result.scheduled.mismatches.length,
      publishedChecked: result.publishedRecent.checked,
      publishedMismatches: result.publishedRecent.mismatches.length,
      baseModelChecked: result.baseModel.checked,
      baseModelComparedDocs: result.baseModel.comparedDocs ?? 0,
      baseModelWithCheckpoint: result.baseModel.withCheckpoint ?? 0,
      baseModelWithDocValue: result.baseModel.withDocValue ?? 0,
      baseModelMismatches: countAlerting(result.baseModel.mismatches),
      baseModelUnfilterable: countUnfilterable(result.baseModel.mismatches),
      baseModelError: result.baseModelError,
      durationSec,
    };
  },
  // Three sampled queries + a batch doc fetch each; keep the single-runner lock short.
  { lockExpiration: 5 * 60 }
);
