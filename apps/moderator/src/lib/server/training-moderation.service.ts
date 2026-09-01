import { env } from '$env/dynamic/private';
import { sql } from '@civitai/db/kysely';
import { getWorkflow } from '@civitai/client';
import { dbRead, dbWrite } from './db';
import { getOrchestratorClient, releaseModerationGate } from './orchestrator';
import { syncSearchIndex } from './search-index';
import { civitaiWebhookUrl } from './civitai-url';
import { callModEndpoint, type ActionResult } from './user-actions.service';
import { recordModActivity } from './mod-activity';
import { logToAxiom } from './axiom';

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
 * be approved — the gate job is gone — so listing it gives the moderator a row whose every button
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
 * Releases the orchestrator's ambient "gate" job for a paused training run.
 *
 * The gate is the SECOND job of the workflow's first step — the orchestrator's own ordering, not a
 * detail of ours, and indexing anywhere else approves a different job. The webhook POST afterwards is
 * not belt-and-braces: the orchestrator does not reliably fire it itself, so without it an approved run
 * stays Paused in our database.
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
}): Promise<ActionResult> {
  const result = await callModEndpoint('csam/training-data-report', input, 'CSAM report');
  return result.ok ? { ok: true } : result;
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
