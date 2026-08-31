import { Prisma } from '@prisma/client';
import type { BitdexDocument } from '~/server/bitdex/client';
import { fetchBitdexDocuments } from '~/server/bitdex/client';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import {
  bitdexAuditCheckedCounter,
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

// Doc fields the comparison reads. publishedAt is fetched alongside isPublished
// because isPublished is an exists_boolean derived FROM publishedAt in the index
// config: if the boolean is ever absent from a doc payload, publishedAt still carries
// the same fact, and disagreement between the two would itself be a finding.
const AUDIT_DOC_FIELDS = ['id', 'isPublished', 'publishedAt', 'sortAt'];

// The baseModel stratum still needs the publication pair, because a document that is
// absent or unpublished is stratum B's finding and must not be re-reported here.
const BASEMODEL_DOC_FIELDS = ['id', 'isPublished', 'publishedAt', 'baseModel'];

// Cap on mismatch rows written to Axiom per run. The counters carry the rate; the log
// only has to carry enough ids to start an investigation.
const MAX_LOGGED_MISMATCHES = 25;

export type AuditStratum = 'scheduled' | 'published_recent' | 'basemodel';
export type MismatchKind =
  | 'scheduled_visible'
  | 'published_missing'
  | 'sortat_drift'
  | 'basemodel_not_checkpoint'
  | 'basemodel_missing';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type AuditConfig = {
  sampleSize: number;
  publishedWindowSecs: number;
  sortAtToleranceSecs: number;
  settleSecs: number;
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
  // selects it; a set rather than a scalar because an image can carry more than one
  // checkpoint, and because the comparison is membership — which resource supplied the
  // value is the whole question, and ordering is not.
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
  settleSecs,
}: Pick<AuditConfig, 'sampleSize' | 'publishedWindowSecs' | 'settleSecs'>): Prisma.Sql {
  return Prisma.sql`
    SELECT
      i.id AS "imageId",
      p.id AS "postId",
      extract(epoch FROM p."publishedAt")::double precision AS "publishedAtSecs",
      extract(epoch FROM GREATEST(p."publishedAt", i."scannedAt", i."createdAt"))::double precision
        AS "expectedSortAtSecs",
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
      AND p."updatedAt" < now() - make_interval(secs => ${settleSecs})
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

// Reads BitDex's answer out of a doc payload. isPublished is the authority when the
// key is present; publishedAt is the fallback, because the index derives isPublished
// from it via exists_boolean and the two carry the same fact.
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
      // An absent or unpublished document is stratum B's finding. Reporting it again
      // here would double-count one lost write as two defects in two places.
      if (!state.present || !state.published) continue;

      const expected = row.expectedBaseModels ?? [];

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

      if (!expected.includes(state.baseModel)) {
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
};

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
  for (const row of rows) {
    const state = readDocState(byId.get(row.imageId));
    if (!state.present || !state.published) continue;
    comparedDocs++;
    if ((row.expectedBaseModels ?? []).length) withCheckpoint++;
  }
  return { comparedDocs, withCheckpoint };
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
};

export async function runAudit(config: AuditConfig): Promise<AuditResult> {
  const scheduled = await auditStratum('scheduled', buildScheduledSampleQuery(config), config);
  const publishedRecent = await auditStratum(
    'published_recent',
    buildPublishedSampleQuery(config),
    config
  );
  const baseModel = await auditStratum(
    'basemodel',
    buildBaseModelSampleQuery(config),
    config,
    BASEMODEL_DOC_FIELDS
  );
  return { scheduled, publishedRecent, baseModel };
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
    const durationSec = (Date.now() - start) / 1000;

    const scopes = [result.scheduled, result.publishedRecent, result.baseModel];
    for (const scope of scopes) {
      bitdexAuditCheckedCounter?.inc({ stratum: scope.stratum }, scope.checked);
      for (const mismatch of scope.mismatches)
        bitdexAuditMismatchCounter?.inc({ stratum: scope.stratum, kind: mismatch.kind }, 1);
    }

    bitdexAuditRunsCounter?.inc();
    bitdexAuditRunDurationHistogram?.observe(durationSec);

    const allMismatches = scopes.flatMap((s) => s.mismatches);

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
        baseModelMismatches: result.baseModel.mismatches.length,
        // Ids and expected-vs-actual, so a firing alert has a trail to pull on
        // instead of only a rate.
        mismatches: allMismatches.slice(0, MAX_LOGGED_MISMATCHES),
        mismatchesTruncated: Math.max(0, allMismatches.length - MAX_LOGGED_MISMATCHES),
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
      baseModelMismatches: result.baseModel.mismatches.length,
      durationSec,
    };
  },
  // Three sampled queries + a batch doc fetch each; keep the single-runner lock short.
  { lockExpiration: 5 * 60 }
);
