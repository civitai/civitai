import { env } from '$env/dynamic/private';
import { sql } from '@civitai/db/kysely';
import { getWorkflow } from '@civitai/client';
import { dbRead, dbWrite } from './db';
import { getManagerWorkflow, getOrchestratorClient, releaseModerationGate } from './orchestrator';
import { syncSearchIndex } from './search-index';
import { civitaiWebhookUrl } from './civitai-url';
import { callModEndpoint, type ActionResult } from './user-actions.service';
import { recordModActivity } from './mod-activity';
import { logToAxiom } from './axiom';
import { getClickhouse } from './clickhouse';
import { TRAINING_STEP_TYPES } from './training-orchestration.service';
import { usersByIds } from './users.service';

export const TRAINING_DATA_FILE_TYPE = 'Training Data';
const ANNOUNCEMENT_KEY = 'training-announcement';

export type TrainingResults = {
  version?: number;
  workflowId?: string;
  jobId?: string | null;
  startedAt?: string;
  submittedAt?: string;
  completedAt?: string;
  epochs?: unknown[];
  history?: unknown[];
};

type FileMetadata = {
  numImages?: number;
  numCaptions?: number;
  trainingResults?: TrainingResults;
};

/**
 * A version can carry several `Training Data` files and only one of them holds the run that matters.
 * Ported from the main app's `pickBestTrainingFile` — the scoring, not just "the first row": picking
 * differently shows a moderator a workflow id that belongs to a different attempt.
 */
function pickBestTrainingFile<T extends { metadata: unknown }>(files: T[]): T | undefined {
  if (files.length <= 1) return files[0];

  let best: T | undefined;
  let bestScore = -1;
  for (const file of files) {
    const tr = (file.metadata as FileMetadata | null)?.trainingResults;
    let score = 0;
    if (tr) {
      score += 1;
      if (tr.workflowId) score += 2;
      if (tr.history?.length) score += 1;
      if (tr.epochs?.length) score += 2;
      if (tr.submittedAt) score += 1;
      if (tr.startedAt) score += 1;
      if (tr.completedAt) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = file;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Training models feed
// ---------------------------------------------------------------------------------------------

export type TrainingFeedQuery = {
  limit: number;
  cursor?: number;
  username?: string;
  workflowId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  cannotPublish?: boolean;
};

export type TrainingFeedFile = {
  id: number;
  name: string;
  sizeKB: number;
  createdAt: Date;
  numImages: number | null;
  numCaptions: number | null;
};

export type TrainingFeedVersion = {
  id: number;
  name: string;
  status: string;
  baseModel: string;
  trainingStatus: string | null;
  createdAt: Date;
  files: TrainingFeedFile[];
};

export type TrainingFeedModel = {
  id: number;
  name: string;
  type: string;
  nsfw: boolean;
  poi: boolean;
  minor: boolean;
  tosViolation: boolean;
  status: string;
  createdAt: Date;
  publishedAt: Date | null;
  cannotPublish: boolean;
  userId: number;
  username: string | null;
  userImage: string | null;
  versions: TrainingFeedVersion[];
};

export async function getTrainingModelsFeed(query: TrainingFeedQuery): Promise<{
  items: TrainingFeedModel[];
  nextCursor?: number;
}> {
  const { limit, cursor, username, workflowId, dateFrom, dateTo, cannotPublish } = query;

  const models = await dbRead
    .selectFrom('Model as m')
    .innerJoin('User as u', 'u.id', 'm.userId')
    .where('m.uploadType', '=', 'Trained')
    .where('m.deletedAt', 'is', null)
    .$if(cursor != null, (qb) => qb.where('m.id', '<', cursor!))
    // Exact match, as the main app's feed does — a `contains` here would quietly widen a moderator's
    // "show me this account" into every account whose name contains it.
    .$if(!!username, (qb) => qb.where('u.username', '=', username!))
    .$if(!!dateFrom, (qb) => qb.where('m.createdAt', '>=', dateFrom!))
    .$if(!!dateTo, (qb) => qb.where('m.createdAt', '<=', dateTo!))
    .$if(cannotPublish === true, (qb) =>
      qb.where(sql<boolean>`m.meta->'cannotPublish' = 'true'::jsonb`)
    )
    .$if(cannotPublish === false, (qb) =>
      qb.where(sql<boolean>`m.meta->'cannotPublish' IS DISTINCT FROM 'true'::jsonb`)
    )
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('ModelVersion as mv')
          .innerJoin('ModelFile as mf', 'mf.modelVersionId', 'mv.id')
          .select(sql<number>`1`.as('one'))
          .whereRef('mv.modelId', '=', 'm.id')
          .where('mf.type', '=', TRAINING_DATA_FILE_TYPE)
          .where('mf.dataPurged', '=', false)
          .$if(!!workflowId, (qb) =>
            qb.where(sql<boolean>`mf.metadata->'trainingResults'->>'workflowId' = ${workflowId}`)
          )
      )
    )
    .select([
      'm.id',
      'm.name',
      'm.type',
      'm.nsfw',
      'm.poi',
      'm.minor',
      'm.tosViolation',
      'm.status',
      'm.createdAt',
      'm.publishedAt',
      'm.userId',
      'u.username',
      'u.image as userImage',
      sql<boolean>`COALESCE(m.meta->'cannotPublish' = 'true'::jsonb, false)`.as('cannotPublish'),
    ])
    .orderBy('m.id', 'desc')
    .limit(limit)
    .execute();

  const modelIds = models.map((m) => m.id);
  const versions = modelIds.length
    ? await dbRead
        .selectFrom('ModelVersion as mv')
        .select([
          'mv.id',
          'mv.modelId',
          'mv.name',
          'mv.status',
          'mv.baseModel',
          'mv.trainingStatus',
          'mv.createdAt',
        ])
        .where('mv.modelId', 'in', modelIds)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('ModelFile as mf')
              .select(sql<number>`1`.as('one'))
              .whereRef('mf.modelVersionId', '=', 'mv.id')
              .where('mf.type', '=', TRAINING_DATA_FILE_TYPE)
              .where('mf.dataPurged', '=', false)
          )
        )
        .orderBy('mv.createdAt', 'desc')
        .execute()
    : [];

  const versionIds = versions.map((v) => v.id);
  const files = versionIds.length
    ? await dbRead
        .selectFrom('ModelFile as mf')
        .select([
          'mf.id',
          'mf.modelVersionId',
          'mf.name',
          'mf.sizeKB',
          'mf.createdAt',
          sql<number | null>`(mf.metadata->>'numImages')::int`.as('numImages'),
          sql<number | null>`(mf.metadata->>'numCaptions')::int`.as('numCaptions'),
        ])
        .where('mf.modelVersionId', 'in', versionIds)
        .where('mf.type', '=', TRAINING_DATA_FILE_TYPE)
        .where('mf.dataPurged', '=', false)
        .orderBy('mf.id', 'asc')
        .execute()
    : [];

  const filesByVersion = new Map<number, TrainingFeedFile[]>();
  for (const { modelVersionId, ...file } of files) {
    const list = filesByVersion.get(modelVersionId) ?? [];
    list.push(file);
    filesByVersion.set(modelVersionId, list);
  }

  const versionsByModel = new Map<number, TrainingFeedVersion[]>();
  for (const { modelId, ...version } of versions) {
    const list = versionsByModel.get(modelId) ?? [];
    list.push({ ...version, files: filesByVersion.get(version.id) ?? [] });
    versionsByModel.set(modelId, list);
  }

  return {
    items: models.map((m) => ({ ...m, versions: versionsByModel.get(m.id) ?? [] })),
    nextCursor: models.length === limit ? models[models.length - 1].id : undefined,
  };
}

/** The account a model belongs to. Read server-side so a ban can never target a posted id. */
export async function getModelOwner(modelId: number): Promise<{ userId: number } | null> {
  const row = await dbRead
    .selectFrom('Model')
    .select('userId')
    .where('id', '=', modelId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  return row ?? null;
}

/** Toggles `meta.cannotPublish`, which the main app's publish path reads. The merge is a jsonb `||` so
 *  the rest of `meta` — minor-flag snapshots, scan state — survives the write. */
export async function toggleCannotPublish(
  modelId: number
): Promise<{ ok: true; cannotPublish: boolean } | { ok: false; error: string }> {
  const model = await dbWrite
    .selectFrom('Model')
    .select(
      sql<boolean>`COALESCE(meta->'cannotPublish' = 'true'::jsonb, false)`.as('cannotPublish')
    )
    .where('id', '=', modelId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!model) return { ok: false, error: 'Model not found.' };

  const next = !model.cannotPublish;
  const result = await dbWrite
    .updateTable('Model')
    .set({
      meta: sql`COALESCE("meta", '{}'::jsonb) || jsonb_build_object('cannotPublish', ${next}::boolean)`,
    })
    .where('id', '=', modelId)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) return { ok: false, error: 'Model not found.' };

  await syncSearchIndex({ entityType: 'model', entityId: modelId, action: 'update' });
  return { ok: true, cannotPublish: next };
}

// ---------------------------------------------------------------------------------------------
// Training page announcement
// ---------------------------------------------------------------------------------------------

export const ANNOUNCEMENT_COLORS = ['yellow', 'red', 'blue', 'green', 'gray'] as const;
export type AnnouncementColor = (typeof ANNOUNCEMENT_COLORS)[number];
export type TrainingAnnouncement = { message: string; color: AnnouncementColor };

// Read through the primary: the panel reloads immediately after saving, and on replica lag it would
// show the operator the text they just replaced.
export async function getTrainingAnnouncement(): Promise<TrainingAnnouncement | null> {
  const row = await dbWrite
    .selectFrom('KeyValue')
    .select('value')
    .where('key', '=', ANNOUNCEMENT_KEY)
    .executeTakeFirst();
  const value = row?.value as Partial<TrainingAnnouncement> | undefined;
  if (!value || typeof value.message !== 'string') return null;
  const color = ANNOUNCEMENT_COLORS.includes(value.color as AnnouncementColor)
    ? (value.color as AnnouncementColor)
    : 'yellow';
  return { message: value.message, color };
}

export async function setTrainingAnnouncement(value: TrainingAnnouncement): Promise<void> {
  await dbWrite
    .insertInto('KeyValue')
    .values({ key: ANNOUNCEMENT_KEY, value: sql`${JSON.stringify(value)}::jsonb` })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({ value: sql`${JSON.stringify(value)}::jsonb` })
    )
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Training data review (paused gate)
// ---------------------------------------------------------------------------------------------

export type PausedTrainingRow = {
  id: number;
  name: string;
  createdAt: Date;
  modelId: number;
  modelName: string;
  workflowId: string | null;
};

/**
 * The paused queue, filtered to versions whose workflow the orchestrator still has.
 *
 * The orchestrator round-trip is NOT incidental. A paused version whose workflow has expired can never
 * be approved — the gate is gone — so listing it gives the moderator a row whose every button
 * errors. Reading the workflow also nudges the orchestrator into reaping failed/expired jobs, which is
 * the only thing in either app that moves those runs out of `Paused`.
 *
 * When the orchestrator is unreachable the queue is returned UNFILTERED and says so. Dropping every row
 * on a transport failure would render as "nothing to review", which is the one answer this page must
 * never give wrongly.
 */
export async function getPausedTrainingVersions(query: {
  limit: number;
  cursor?: number;
}): Promise<{
  items: PausedTrainingRow[];
  nextCursor?: number;
  workflowFilterUnavailable: boolean;
}> {
  const rows = await dbWrite
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select(['mv.id', 'mv.name', 'mv.createdAt', 'm.id as modelId', 'm.name as modelName'])
    .where('mv.trainingStatus', '=', 'Paused')
    .$if(query.cursor != null, (qb) => qb.where('mv.id', '<', query.cursor!))
    .orderBy('mv.id', 'desc')
    .limit(query.limit)
    .execute();

  const nextCursor = rows.length === query.limit ? rows[rows.length - 1].id : undefined;
  if (!rows.length) return { items: [], nextCursor, workflowFilterUnavailable: false };

  // Same picker the detail page and the gate use. A different one here would print an id in the queue
  // that is not the run the Approve button acts on, one click away.
  const files = await dbWrite
    .selectFrom('ModelFile')
    .select(['id', 'modelVersionId', 'metadata'])
    .where(
      'modelVersionId',
      'in',
      rows.map((r) => r.id)
    )
    .where('type', '=', TRAINING_DATA_FILE_TYPE)
    .execute();

  const byVersion = new Map<number, typeof files>();
  for (const file of files) {
    const list = byVersion.get(file.modelVersionId) ?? [];
    list.push(file);
    byVersion.set(file.modelVersionId, list);
  }

  const withWorkflow = rows.map((row) => {
    const best = pickBestTrainingFile(byVersion.get(row.id) ?? []);
    const results = (best?.metadata as FileMetadata | null)?.trainingResults;
    return { ...row, workflowId: results?.workflowId ?? null };
  });

  if (!env.ORCHESTRATOR_ENDPOINT || !env.ORCHESTRATOR_ACCESS_TOKEN)
    return { items: withWorkflow, nextCursor, workflowFilterUnavailable: true };

  const client = getOrchestratorClient();
  const live = await Promise.all(
    withWorkflow.map(async (row) => {
      if (!row.workflowId) return { row, alive: false, reachable: true };
      try {
        const { data, error, response } = await getWorkflow({
          client,
          path: { workflowId: row.workflowId },
        });
        if (!error && data) return { row, alive: true, reachable: true };
        // The client reports HTTP failures in `error` rather than throwing, so status is the only thing
        // separating "this workflow is gone" (404 — genuinely not reviewable) from "the orchestrator is
        // refusing or broken" (401/5xx — every row would look gone, and the queue would read empty).
        const status = response?.status ?? 0;
        return { row, alive: false, reachable: status === 404 || status === 410 };
      } catch {
        return { row, alive: false, reachable: false };
      }
    })
  );

  // One transport failure means the filter is untrustworthy for the whole page, not just its row.
  const unreachable = live.some((r) => !r.reachable);
  return {
    items: unreachable ? withWorkflow : live.filter((r) => r.alive).map((r) => r.row),
    nextCursor,
    workflowFilterUnavailable: unreachable,
  };
}

export type TrainingVersionDetail = {
  versionId: number;
  versionName: string;
  modelId: number;
  modelName: string;
  userId: number;
  username: string | null;
  workflowId: string | null;
  jobId: string | null;
  trainingResults: TrainingResults;
};

/**
 * Reads through the WRITE connection. `ModelFile.metadata` is TOASTed jsonb, which the logical
 * subscriber feeding the replica drops on UPDATE — on the replica `trainingResults` comes back empty
 * and the review page shows no workflow at all.
 */
export async function getTrainingVersionDetail(
  versionId: number
): Promise<TrainingVersionDetail | null> {
  const version = await dbWrite
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .innerJoin('User as u', 'u.id', 'm.userId')
    .select([
      'mv.id as versionId',
      'mv.name as versionName',
      'm.id as modelId',
      'm.name as modelName',
      'u.id as userId',
      'u.username',
    ])
    .where('mv.id', '=', versionId)
    .executeTakeFirst();
  if (!version) return null;

  const trainingResults = await getTrainingResults(versionId);

  return {
    ...version,
    workflowId: trainingResults?.workflowId ?? null,
    jobId: trainingResults?.jobId ?? null,
    trainingResults: trainingResults ?? {},
  };
}

/**
 * The training file whose run is still AWAITING a gate.
 *
 * NOT `pickBestTrainingFile`: that scores a run UP for completion markers (+2 epochs, +1
 * `completedAt`), which is right for "show me this version's dataset" and exactly backwards for
 * finding a gate — a run waiting on one is by construction the least complete. On a version with two
 * runs the scored picker returns the finished one, and approving would release the wrong workflow.
 */
function pickGatedTrainingFile<T extends { metadata: unknown }>(files: T[]): T | undefined {
  const pending = files.filter((file) => {
    const tr = (file.metadata as FileMetadata | null)?.trainingResults;
    return !!tr?.workflowId && !tr?.completedAt;
  });
  return pending[0] ?? files[0];
}

/** The gate's workflow, as opposed to the dataset's — see `pickGatedTrainingFile`. */
async function getGateTrainingResults(versionId: number): Promise<TrainingResults | null> {
  const files = await dbWrite
    .selectFrom('ModelFile')
    .select(['id', 'metadata'])
    .where('modelVersionId', '=', versionId)
    .where('type', '=', TRAINING_DATA_FILE_TYPE)
    .orderBy('id', 'asc')
    .execute();
  return (pickGatedTrainingFile(files)?.metadata as FileMetadata | null)?.trainingResults ?? null;
}

async function getTrainingResults(versionId: number): Promise<TrainingResults | null> {
  const files = await dbWrite
    .selectFrom('ModelFile')
    .select(['id', 'metadata'])
    .where('modelVersionId', '=', versionId)
    .where('type', '=', TRAINING_DATA_FILE_TYPE)
    .execute();

  const best = pickBestTrainingFile(files);
  return (best?.metadata as FileMetadata | null)?.trainingResults ?? null;
}

/**
 * Releases the orchestrator's moderation gate for a paused training run.
 *
 * The webhook POST afterwards is not belt-and-braces: the orchestrator does not reliably fire it
 * itself, so without it an approved run stays Paused in our database.
 */
export async function moderateTrainingData(input: {
  modelVersionId: number;
  approve: boolean;
  moderatorId: number;
}): Promise<ActionResult> {
  const endpoint = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!endpoint || !token) return { ok: false, error: 'Orchestrator is not configured.' };

  const trainingResults = await getGateTrainingResults(input.modelVersionId);
  const workflowId = trainingResults?.workflowId;
  if (!workflowId) return { ok: false, error: 'No workflow id on this version.' };

  const { data: workflow, error } = await getWorkflow({
    client: getOrchestratorClient(),
    path: { workflowId },
  });
  if (error || !workflow) return { ok: false, error: `Could not load workflow ${workflowId}.` };

  // Checked BEFORE the gate is released, because both are knowable from what we already hold and
  // neither is recoverable afterwards: releasing a gate we cannot then record leaves the version Paused
  // with its job already approved, which is an incident per row rather than a retryable failure.
  if (!env.WEBHOOK_TOKEN)
    return {
      ok: false,
      error:
        'WEBHOOK_TOKEN is not configured, so the approval could not be recorded. Nothing was changed.',
    };
  if (!workflow.status)
    return {
      ok: false,
      error: `Workflow ${workflowId} reports no status, so the approval could not be recorded. Nothing was changed.`,
    };
  // The workflow id lives in ModelFile.metadata, which the model's OWNER can write, so on its own it
  // does not establish that this workflow is the one this version submitted. The tag is written by
  // the main app at submit time and the reviewed user cannot set it.
  if (!workflow.tags?.includes(`modelVersion:${input.modelVersionId}`))
    return {
      ok: false,
      error: `Workflow ${workflowId} does not belong to model version ${input.modelVersionId}, so the gate was not touched. Escalate this — it should not happen.`,
    };

  const released = await releaseModerationGate(workflowId, input.approve);
  if (!released.ok) return released;

  await recordModActivity({
    userId: input.moderatorId,
    entityType: 'modelVersion',
    entityId: input.modelVersionId,
    activity: input.approve ? 'trainingData:approve' : 'trainingData:deny',
  });
  logToAxiom({
    name: 'training-data-moderation',
    type: 'info',
    modelVersionId: input.modelVersionId,
    workflowId,
    approved: input.approve,
    moderatorId: input.moderatorId,
  });

  const synced = await notifyTrainingWebhook(input.modelVersionId, workflowId, workflow.status);
  if (!synced) {
    logToAxiom({
      name: 'training-data-moderation',
      type: 'error',
      important: true,
      message: 'gate released but the webhook did not land',
      modelVersionId: input.modelVersionId,
      workflowId,
      moderatorId: input.moderatorId,
    });
    return {
      ok: false,
      error: `The gate was ${
        input.approve ? 'approved' : 'denied'
      } at the orchestrator, but this version could not be taken out of Paused. Do NOT repeat the action — tell an infra owner.`,
    };
  }
  return { ok: true };
}

export const CSAM_CONTENTS = {
  nonRealMinors: 'AI-generated images/videos of non-real minors',
  realMinors: 'AI-edited images/videos of real minors',
  variations: 'AI-generated variations of uploaded CSAM',
  other: 'AI-generated sexualization of uploaded images/videos of minors',
} as const;
export type CsamContent = keyof typeof CSAM_CONTENTS;
export const CSAM_CONTENT_KEYS = Object.keys(CSAM_CONTENTS) as CsamContent[];

/**
 * Filing the report is the action, not a flag: the endpoint also denies the run and soft-deletes the
 * account. It stays in the main app because that fan-out — the NCMEC report row, the deny, the
 * soft-delete — is one transaction the spoke would have to re-derive.
 */
export async function reportTrainingDataCsam(input: {
  userId: number;
  modelVersionId: number;
  minorDepiction: 'real' | 'non-real';
  contents: CsamContent[];
}): Promise<ActionResult | { ok: true; warning: string }> {
  const result = await callModEndpoint('csam/training-data-report', input, 'CSAM report');
  if (!result.ok) return result;
  // 200 with a `warning` body means a leg of the fan-out failed (the report and soft-delete landed
  // anyway). Dropping it reports a live training run as fully handled.
  const warning = typeof result.body?.warning === 'string' ? result.body.warning : undefined;
  return warning ? { ok: true, warning } : { ok: true };
}

/**
 * Returns whether our side of the approval landed. The gate is already released at this point, so a
 * failure here is NOT a failed action — it is a half-done one, and reporting it as success is what
 * leaves a moderator re-approving the same rows every load while every gate is already open.
 */
async function notifyTrainingWebhook(
  modelVersionId: number,
  workflowId: string,
  status: string | undefined
): Promise<boolean> {
  const token = env.WEBHOOK_TOKEN;
  if (!token || !status) return false;

  const base = civitaiWebhookUrl();

  try {
    const res = await fetch(
      `${base}/webhooks/resource-training-v2/${modelVersionId}?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId, status }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) console.error('[training-moderation] training webhook returned', res.status);
    return res.ok;
  } catch (e) {
    console.error('[training-moderation] training webhook failed', e);
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Workflow-only training runs (no ModelVersion)
// ---------------------------------------------------------------------------------------------
//
// Training Studio and App Block trainings are submitted straight to the orchestrator, so no
// `ModelVersion` row exists and nothing above can reach them: the Paused queue is a Postgres query, and
// `moderateTrainingData` refuses a workflow without a `modelVersion:<id>` tag. Everything here is keyed
// by the WORKFLOW id instead, and reads the run from the orchestrator rather than from our database.
//
// The workflow id is the only identity there is, and it is minted by the orchestrator as
// `<submitter user id>-<UTC yyyyMMddHHmmss><fraction>[-<suffix>]`. The owner is read from THAT, never
// from `metadata` or `tags`, which the submitter writes.

const WORKFLOW_ID_PATTERN = /^(\d{1,10})-(\d{14})\d{0,6}(?:-[a-z0-9]{1,32})?$/;
const MAX_INT4 = 2_147_483_647;

export type ParsedWorkflowId = { ownerId: number; submittedAt: Date };

/** The submitter and submit instant carried by an orchestrator workflow id, or null when the id is not
 *  one. Doubles as the input guard: nothing that fails this reaches a URL or a query. */
export function parseWorkflowId(raw: string | null | undefined): ParsedWorkflowId | null {
  if (typeof raw !== 'string') return null;
  const match = WORKFLOW_ID_PATTERN.exec(raw);
  if (!match) return null;
  const ownerId = Number(match[1]);
  if (!Number.isInteger(ownerId) || ownerId <= 0 || ownerId > MAX_INT4) return null;
  const s = match[2];
  const submittedAt = new Date(
    Date.UTC(
      +s.slice(0, 4),
      +s.slice(4, 6) - 1,
      +s.slice(6, 8),
      +s.slice(8, 10),
      +s.slice(10, 12),
      +s.slice(12, 14)
    )
  );
  if (Number.isNaN(submittedAt.getTime())) return null;
  return { ownerId, submittedAt };
}

/** Step types that are a training run, as the orchestrator's workflow JSON names them. */
const WORKFLOW_TRAINING_STEP_TYPES = ['training', 'imageResourceTraining'] as const;

/**
 * How long the orchestrator holds a gate when the step sets no timeout, per step type. Past it the gate
 * expires and the run is refunded, so a review that lands later does nothing.
 */
const DEFAULT_GATE_WINDOW_MS: Record<(typeof WORKFLOW_TRAINING_STEP_TYPES)[number], number> = {
  training: 48 * 3_600_000,
  imageResourceTraining: 24 * 3_600_000,
};

type RawStep = {
  $type?: unknown;
  timeout?: unknown;
  startedAt?: unknown;
  input?: unknown;
  output?: unknown;
};
type RawWorkflow = {
  id?: unknown;
  status?: unknown;
  createdAt?: unknown;
  tags?: unknown;
  steps?: unknown;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function trainingStepOf(
  workflow: RawWorkflow
): (RawStep & { $type: (typeof WORKFLOW_TRAINING_STEP_TYPES)[number] }) | null {
  const steps = Array.isArray(workflow.steps) ? (workflow.steps as RawStep[]) : [];
  const step = steps.find(
    (s) =>
      !!s &&
      typeof s === 'object' &&
      (WORKFLOW_TRAINING_STEP_TYPES as readonly unknown[]).includes(s.$type)
  );
  return (
    (step as (RawStep & { $type: (typeof WORKFLOW_TRAINING_STEP_TYPES)[number] }) | undefined) ??
    null
  );
}

/** Lower-cased: the manager API writes `UnderReview`, the consumer API `underReview`. */
function moderationStatusOf(step: RawStep | null): string | null {
  const output = step?.output as { moderationStatus?: unknown } | null | undefined;
  const status = str(output?.moderationStatus);
  return status ? status.toLowerCase() : null;
}

const UNDER_REVIEW = 'underreview';

function tagsOf(workflow: RawWorkflow): string[] {
  return Array.isArray(workflow.tags)
    ? workflow.tags.filter((t): t is string => typeof t === 'string')
    : [];
}

/** The version a main-app training run belongs to. Such a run is reviewed on the version route, which
 *  also syncs our database — this path would release the gate and leave the version Paused. */
function modelVersionIdOf(tags: string[]): number | null {
  for (const tag of tags) {
    const match = /^modelVersion:(\d+)$/.exec(tag);
    if (match) return Number(match[1]);
  }
  return tags.some((t) => t.startsWith('modelVersion:')) ? -1 : null;
}

export type WorkflowOrigin =
  | { kind: 'app-block'; appId: string }
  | { kind: 'studio' }
  | { kind: 'other' };

/** Display only — the submitter writes these tags, so nothing is decided on them. */
function originOf(tags: string[]): WorkflowOrigin {
  const app = tags.find((t) => t.startsWith('app-block:'));
  if (app && app.length > 'app-block:'.length)
    return { kind: 'app-block', appId: app.slice('app-block:'.length) };
  if (tags.includes('training')) return { kind: 'studio' };
  return { kind: 'other' };
}

/** A .NET `TimeSpan` as the orchestrator serialises it — `[d.]hh:mm:ss[.fffffff]` — in ms. */
export function parseTimeSpanMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value);
  if (!match) return null;
  const [, d, h, m, s] = match;
  return ((Number(d ?? 0) * 24 + Number(h)) * 60 + Number(m)) * 60_000 + Number(s) * 1000;
}

/**
 * When the gate stops accepting a ruling: the step's start plus its timeout, or the per-type default.
 * Approximate — the orchestrator stamps the deadline when it builds the jobs, a moment after start.
 */
function gateExpiresAt(
  workflow: RawWorkflow,
  step: RawStep & { $type: (typeof WORKFLOW_TRAINING_STEP_TYPES)[number] },
  submittedAt: Date
): string | null {
  const startMs = [str(step.startedAt), str(workflow.createdAt)]
    .map((v) => (v ? Date.parse(v) : NaN))
    .find((ms) => !Number.isNaN(ms));
  const start = startMs ?? submittedAt.getTime();
  const window = parseTimeSpanMs(step.timeout) ?? DEFAULT_GATE_WINDOW_MS[step.$type];
  return new Date(start + window).toISOString();
}

const BLOB_KEY_PATTERN = /^[0-9a-fA-F]{32}\.[A-Za-z0-9]{2,5}$/;
const BLOB_AIR_PREFIX = 'urn:air:other:other:orchestrator:blob@';

/** The blob key an item's `air` names. The orchestrator normalises items to the AIR form at submit, so
 *  the bare key is accepted only as a fallback; anything else is not served. */
function blobKeyOf(air: unknown): string | null {
  const value = str(air);
  if (!value) return null;
  const key = value.startsWith(BLOB_AIR_PREFIX) ? value.slice(BLOB_AIR_PREFIX.length) : value;
  return BLOB_KEY_PATTERN.test(key) ? key : null;
}

const MEDIA_BY_EXTENSION: Record<string, 'image' | 'video' | 'audio'> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  gif: 'image',
  mp4: 'video',
  webm: 'video',
  mp3: 'audio',
  wav: 'audio',
};

export type WorkflowDatasetItem = {
  index: number;
  /** Null when the item names something other than an orchestrator blob; such an item is not served. */
  blobKey: string | null;
  caption: string | null;
  media: 'image' | 'video' | 'audio' | 'other';
};

export type WorkflowDataset =
  | { kind: 'blobs'; items: WorkflowDatasetItem[] }
  /** A packaged dataset (a zip). Its contents are not previewable here. */
  | { kind: 'archive'; count: number | null }
  | { kind: 'unknown' };

function datasetOf(step: RawStep): WorkflowDataset {
  const input = step.input as { trainingData?: unknown; trainingDataImagesCount?: unknown } | null;
  const data = input?.trainingData;
  if (data && typeof data === 'object') {
    const d = data as { type?: unknown; items?: unknown; count?: unknown };
    if (d.type === 'blobs' && Array.isArray(d.items))
      return {
        kind: 'blobs',
        items: d.items.map((raw, index) => {
          const item = (raw ?? {}) as { air?: unknown; caption?: unknown };
          const blobKey = blobKeyOf(item.air);
          const ext = blobKey?.split('.').pop()?.toLowerCase() ?? '';
          return {
            index,
            blobKey,
            caption: str(item.caption),
            media: MEDIA_BY_EXTENSION[ext] ?? 'other',
          };
        }),
      };
    if (d.type === 'zip')
      return { kind: 'archive', count: typeof d.count === 'number' ? d.count : null };
  }
  // imageResourceTraining's original shape: a URL to an archive plus a count beside it.
  if (typeof data === 'string')
    return {
      kind: 'archive',
      count:
        typeof input?.trainingDataImagesCount === 'number' ? input.trainingDataImagesCount : null,
    };
  return { kind: 'unknown' };
}

export type TrainingWorkflowDetail = {
  workflowId: string;
  ownerId: number;
  username: string | null;
  submittedAt: string;
  status: string | null;
  stepType: string;
  /** Lower-cased (`underreview`, `approved`, …); null when the step reports none yet. */
  moderationStatus: string | null;
  underReview: boolean;
  origin: WorkflowOrigin;
  /** Set when the run belongs to a model version — it is then reviewed on the version route instead.
   *  -1 when the tag is present but unreadable. */
  modelVersionId: number | null;
  expiresAt: string | null;
  dataset: WorkflowDataset;
};

export type WorkflowLoad =
  | { ok: true; detail: TrainingWorkflowDetail }
  | { ok: false; status: number; error: string };

/**
 * One workflow-only run, read for review. Pure over the workflow JSON so the ruling, the page and the
 * blob route all decide "which run, whose, what state" from the same reading.
 */
export function readTrainingWorkflow(
  workflowId: string,
  raw: unknown
): { ok: true; detail: Omit<TrainingWorkflowDetail, 'username'> } | { ok: false; error: string } {
  const parsed = parseWorkflowId(workflowId);
  if (!parsed) return { ok: false, error: 'Not a workflow id.' };
  if (!raw || typeof raw !== 'object')
    return { ok: false, error: `Workflow ${workflowId} could not be read.` };
  const workflow = raw as RawWorkflow;
  // The manager read is keyed by the id we asked for; a body naming a different one is not this run.
  if (str(workflow.id) && workflow.id !== workflowId)
    return {
      ok: false,
      error: `The orchestrator returned a different workflow for ${workflowId}.`,
    };

  const step = trainingStepOf(workflow);
  if (!step) return { ok: false, error: `Workflow ${workflowId} has no training step.` };

  const tags = tagsOf(workflow);
  const moderationStatus = moderationStatusOf(step);
  return {
    ok: true,
    detail: {
      workflowId,
      ownerId: parsed.ownerId,
      submittedAt: parsed.submittedAt.toISOString(),
      status: str(workflow.status),
      stepType: step.$type,
      moderationStatus,
      underReview: moderationStatus === UNDER_REVIEW,
      origin: originOf(tags),
      modelVersionId: modelVersionIdOf(tags),
      expiresAt: gateExpiresAt(workflow, step, parsed.submittedAt),
      dataset: datasetOf(step),
    },
  };
}

/** Status of a failed load: 400 for a malformed id, 404 for a run the orchestrator does not have, 502
 *  when it could not be asked. */
export async function getTrainingWorkflowDetail(workflowId: string): Promise<WorkflowLoad> {
  if (!parseWorkflowId(workflowId)) return { ok: false, status: 400, error: 'Not a workflow id.' };
  const loaded = await getManagerWorkflow(workflowId);
  if (!loaded.ok)
    return {
      ok: false,
      status: loaded.status === 404 || loaded.status === 410 ? 404 : 502,
      error: loaded.error,
    };
  const read = readTrainingWorkflow(workflowId, loaded.workflow);
  if (!read.ok) return { ok: false, status: 422, error: read.error };

  const users = await usersByIds([read.detail.ownerId]).catch(() => new Map());
  return {
    ok: true,
    detail: { ...read.detail, username: users.get(read.detail.ownerId)?.username ?? null },
  };
}

const MAX_RULING_MESSAGE = 1000;

/** Delays between re-reads after a release. The release returns before the gate job completes, so the
 *  first read can still say under review for a ruling that is about to land. */
const RECHECK_DELAYS_MS = [750, 1500, 3000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Approve or deny the moderation gate of a workflow-only training run.
 *
 * Every refusal below happens BEFORE the gate is touched, from a workflow read this call made itself.
 * Releasing is the one irreversible step, and the orchestrator answers 204 even when the ruling did not
 * take (a gate it is not tracking), so the run is re-read afterwards and only a status that actually
 * moved counts as done. Refunds on deny/expiry are the orchestrator's; nothing here moves Buzz.
 */
export async function moderateTrainingWorkflow(
  input: { workflowId: string; approve: boolean; message?: string | null; moderatorId: number },
  options: { recheckDelaysMs?: number[] } = {}
): Promise<{ ok: true; moderationStatus: string } | { ok: false; error: string }> {
  const { workflowId, approve, moderatorId } = input;
  const parsed = parseWorkflowId(workflowId);
  if (!parsed) return { ok: false, error: 'Not a workflow id. Nothing was changed.' };

  const loaded = await getManagerWorkflow(workflowId);
  if (!loaded.ok) return { ok: false, error: `${loaded.error} Nothing was changed.` };
  const read = readTrainingWorkflow(workflowId, loaded.workflow);
  if (!read.ok) return { ok: false, error: `${read.error} Nothing was changed.` };
  const before = read.detail;

  if (before.modelVersionId !== null)
    return {
      ok: false,
      error:
        before.modelVersionId > 0
          ? `This run belongs to model version ${before.modelVersionId} — review it at /audit/training-data/${before.modelVersionId}, which also updates the version. Nothing was changed.`
          : 'This run carries a model-version tag that could not be read, so it was not touched. Escalate this.',
    };

  if (!before.underReview)
    return {
      ok: false,
      error: `This run is not awaiting review (moderation status: ${
        before.moderationStatus ?? 'none'
      }). Nothing was changed.`,
    };

  const message = approve
    ? undefined
    : input.message?.trim().slice(0, MAX_RULING_MESSAGE) || undefined;
  const released = await releaseModerationGate(workflowId, approve, message);
  if (!released.ok) return { ok: false, error: released.error };

  // Re-read until the status moves. A read that fails is not a verdict either way.
  let after: string | null | undefined;
  for (const delay of options.recheckDelaysMs ?? RECHECK_DELAYS_MS) {
    await sleep(delay);
    const again = await getManagerWorkflow(workflowId);
    if (!again.ok) {
      after = undefined;
      continue;
    }
    const reread = readTrainingWorkflow(workflowId, again.workflow);
    after = reread.ok ? reread.detail.moderationStatus : undefined;
    if (after !== undefined && after !== UNDER_REVIEW) break;
  }

  const log = {
    name: 'training-workflow-moderation',
    workflowId,
    ownerId: parsed.ownerId,
    approved: approve,
    moderatorId,
    after: after ?? null,
  };

  if (after === undefined) {
    logToAxiom({
      ...log,
      type: 'error',
      important: true,
      message: 'gate released, outcome unconfirmed',
    });
    return {
      ok: false,
      error:
        'The orchestrator accepted the ruling but the run could not be re-read to confirm it. Reload this page before doing anything else.',
    };
  }
  if (after === UNDER_REVIEW) {
    logToAxiom({
      ...log,
      type: 'error',
      important: true,
      message: 'gate release accepted but not applied',
    });
    return {
      ok: false,
      error:
        'The orchestrator accepted the ruling, but the run is still under review — it was not applied yet. Retry in a moment.',
    };
  }
  const expected = approve ? 'approved' : 'rejected';
  if (after !== expected) {
    logToAxiom({
      ...log,
      type: 'error',
      important: true,
      message: 'gate ended in an unexpected state',
    });
    return {
      ok: false,
      error: `The run is now "${after}", not ${expected}. It may have expired or been ruled on elsewhere at the same moment.`,
    };
  }

  await recordModActivity({
    userId: moderatorId,
    entityType: 'user',
    entityId: parsed.ownerId,
    activity: approve ? 'trainingWorkflow:approve' : 'trainingWorkflow:deny',
  });
  logToAxiom({ ...log, type: 'info', message: message ?? null });
  return { ok: true, moderationStatus: after };
}

/** How far back a pending gate can have been submitted: the longest default gate window plus slack for
 *  ledger ingestion. A run older than this has expired and been refunded. */
const PENDING_WINDOW_MS = 49 * 3_600_000;
/** Workflows read from the orchestrator per page load, newest first. */
const MAX_PENDING_CANDIDATES = 300;
const PENDING_READ_CONCURRENCY = 8;

export type PendingWorkflowGate = {
  workflowId: string;
  ownerId: number;
  username: string | null;
  submittedAt: string;
  origin: WorkflowOrigin | null;
  expiresAt: string | null;
  /** False when the orchestrator could not be asked about this run, so it is listed unfiltered. */
  verified: boolean;
};

export type PendingWorkflowGates = {
  items: PendingWorkflowGate[];
  /** The charge ledger could not be read, so there is no list at all — NOT "nothing to review". */
  ledgerUnavailable: boolean;
  /** At least one run could not be checked with the orchestrator; those are listed unverified. */
  workflowFilterUnavailable: boolean;
  /** More candidates than one page reads; the oldest were not checked. */
  truncated: boolean;
};

const ymdhms = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Workflow-only training runs waiting on a moderator.
 *
 * The orchestrator cannot be asked "which gates are open" — its list read needs a user and does not
 * filter by status — so candidates come from the Buzz ledger: every training charge in the window, less
 * the ones already refunded and the ones whose training step has already ended (a step row is written
 * only at the end). On 2026-10-05 that took 2,711 charged workflows down to 133. Each survivor is then
 * read from the orchestrator and kept only if it has a training step that is under review and no
 * model-version tag (those are on the version queue above).
 *
 * A run submitted at no charge has no ledger row and does not appear here.
 */
export async function getPendingWorkflowGates(
  options: { now?: number } = {}
): Promise<PendingWorkflowGates> {
  const since = ymdhms((options.now ?? Date.now()) - PENDING_WINDOW_MS);
  // Three queries, not one: the same anti-join written as `NOT IN (subquery)` measured 22s against
  // under 1s for the three run separately.
  let candidates: string[];
  try {
    const ch = getClickhouse();
    const [charges, refunds, ended] = await Promise.all([
      ch.$query<{ workflowId: string }>(`
        SELECT JSONExtractString(details, 'workflowId') AS workflowId
        FROM buzzTransactions
        WHERE type = 'training' AND date >= '${since}' AND workflowId != ''
        GROUP BY workflowId
        ORDER BY max(date) DESC
      `),
      ch.$query<{ workflowId: string }>(`
        SELECT DISTINCT JSONExtractString(details, 'workflowId') AS workflowId
        FROM buzzTransactions
        WHERE type = 'refund' AND date >= '${since}'
      `),
      // The type filter is load-bearing: without it this reads every workflow's steps (tens of millions).
      ch.$query<{ workflowId: string }>(`
        SELECT DISTINCT workflowId
        FROM orchestration.workflowSteps
        WHERE createdAt >= '${since}' AND ${TRAINING_STEP_TYPES}
      `),
    ]);
    const done = new Set([...refunds, ...ended].map((r) => r.workflowId));
    candidates = charges
      .map((c) => c.workflowId)
      .filter((id) => !done.has(id) && parseWorkflowId(id));
  } catch (e) {
    console.error('[training-moderation] pending gate ledger read failed', e);
    return {
      items: [],
      ledgerUnavailable: true,
      workflowFilterUnavailable: false,
      truncated: false,
    };
  }

  const truncated = candidates.length > MAX_PENDING_CANDIDATES;
  const page = candidates.slice(0, MAX_PENDING_CANDIDATES);

  const checked: {
    workflowId: string;
    verdict: 'keep' | 'drop' | 'unknown';
    detail?: Omit<TrainingWorkflowDetail, 'username'>;
  }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < page.length) {
      const workflowId = page[next++];
      const loaded = await getManagerWorkflow(workflowId);
      if (!loaded.ok) {
        // 404/410 is the orchestrator saying the run is gone; anything else is not an answer.
        const gone = loaded.status === 404 || loaded.status === 410;
        checked.push({ workflowId, verdict: gone ? 'drop' : 'unknown' });
        continue;
      }
      const read = readTrainingWorkflow(workflowId, loaded.workflow);
      const keep = read.ok && read.detail.underReview && read.detail.modelVersionId === null;
      checked.push({
        workflowId,
        verdict: keep ? 'keep' : 'drop',
        detail: read.ok ? read.detail : undefined,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PENDING_READ_CONCURRENCY, page.length) }, worker)
  );

  const kept = checked.filter((c) => c.verdict !== 'drop');
  const users = await usersByIds(kept.map((c) => parseWorkflowId(c.workflowId)!.ownerId)).catch(
    () => new Map()
  );

  // Back into ledger order (newest first) — the workers finish out of order.
  const order = new Map(page.map((id, i) => [id, i]));
  const items = kept
    .sort((a, b) => order.get(a.workflowId)! - order.get(b.workflowId)!)
    .map(({ workflowId, verdict, detail }): PendingWorkflowGate => {
      const parsed = parseWorkflowId(workflowId)!;
      return {
        workflowId,
        ownerId: parsed.ownerId,
        username: users.get(parsed.ownerId)?.username ?? null,
        submittedAt: parsed.submittedAt.toISOString(),
        origin: detail?.origin ?? null,
        expiresAt: detail?.expiresAt ?? null,
        verified: verdict === 'keep',
      };
    });

  return {
    items,
    ledgerUnavailable: false,
    workflowFilterUnavailable: kept.some((c) => c.verdict === 'unknown'),
    truncated,
  };
}

const DATASET_CACHE_MS = 60_000;
const DATASET_CACHE_MAX = 50;
const datasetCache = new Map<string, { at: number; dataset: WorkflowDataset; ownerId: number }>();

/** Tests only — the cache is module state. */
export const clearTrainingWorkflowBlobCache = () => datasetCache.clear();

/**
 * The blob key behind item `index` of a workflow-only run's dataset, resolved from a workflow read made
 * here — the browser names a position, never a URL or a key.
 */
export async function resolveTrainingWorkflowBlob(
  workflowId: string,
  index: number
): Promise<
  { ok: true; blobKey: string; ownerId: number } | { ok: false; status: number; error: string }
> {
  if (!parseWorkflowId(workflowId)) return { ok: false, status: 400, error: 'Not a workflow id.' };

  // The review page asks once per thumbnail, so the read is held briefly rather than repeated for
  // every item of a large dataset. Still this app's own read of the workflow, keyed by its id.
  const cached = datasetCache.get(workflowId);
  let entry = cached && Date.now() - cached.at < DATASET_CACHE_MS ? cached : undefined;
  if (!entry) {
    const loaded = await getManagerWorkflow(workflowId);
    if (!loaded.ok)
      return {
        ok: false,
        status: loaded.status === 404 || loaded.status === 410 ? 404 : 502,
        error: loaded.error,
      };
    const read = readTrainingWorkflow(workflowId, loaded.workflow);
    if (!read.ok) return { ok: false, status: 422, error: read.error };
    entry = { at: Date.now(), dataset: read.detail.dataset, ownerId: read.detail.ownerId };
    if (datasetCache.size >= DATASET_CACHE_MAX)
      datasetCache.delete(datasetCache.keys().next().value!);
    datasetCache.set(workflowId, entry);
  }

  const { dataset, ownerId } = entry;
  if (dataset.kind !== 'blobs')
    return { ok: false, status: 404, error: 'This run has no individually stored dataset items.' };
  const item = Number.isInteger(index) && index >= 0 ? dataset.items[index] : undefined;
  if (!item) return { ok: false, status: 404, error: 'No such dataset item.' };
  if (!item.blobKey)
    return { ok: false, status: 404, error: 'This dataset item is not a stored blob.' };
  return { ok: true, blobKey: item.blobKey, ownerId };
}
