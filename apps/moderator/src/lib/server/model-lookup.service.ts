import type {
  Availability,
  CheckpointType,
  ModelFlagStatus,
  ModelModifier,
  ModelStatus,
  ModelType,
  ModelUploadType,
  ModelUsageControl,
  TrainingStatus,
} from '@civitai/db-schema/enums';
import { sql } from 'kysely';
import { dbRead } from './db';
import { getModActivityFor } from './mod-activity';
import { isInt4Id, usersByIds } from './users.service';

// No Retool "Model Lookup" export exists — the name came from the main app's button label, which
// opened Bulk Image Manager keyed to the model. docs/moderator-app/mod-studio-feedback-2026-08-17.md.

export type ModelDetail = {
  id: number;
  name: string;
  type: ModelType;
  status: ModelStatus;
  availability: Availability;
  checkpointType: CheckpointType | null;
  uploadType: ModelUploadType;
  mode: ModelModifier | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  lastVersionAt: Date | null;
  deletedAt: Date | null;
  deletedBy: number | null;
  scannedAt: Date | null;
  nsfw: boolean;
  nsfwLevel: number;
  poi: boolean;
  minor: boolean;
  sfwOnly: boolean;
  tosViolation: boolean;
  locked: boolean;
  lockedProperties: string[];
  unlisted: boolean;
  underAttack: boolean;
  isOfficial: boolean;
  allowNoCredit: boolean;
  allowCommercialUse: string[];
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
  meta: unknown;
  userId: number;
  username: string | null;
  userBannedAt: Date | null;
  /** Characters, not the body — enough to tell a stub from a filled-in page without shipping the HTML. */
  descriptionLength: number;
};

/** The AI content scan's verdict on the model's text. `Pending` is a flag nobody has ruled on yet. */
export type ModelFlagRow = {
  poi: boolean;
  minor: boolean;
  sfwOnly: boolean;
  nsfw: boolean;
  triggerWords: boolean;
  poiName: boolean;
  status: ModelFlagStatus;
  details: unknown;
  createdAt: Date;
};

export type ModelVersionRow = {
  id: number;
  index: number | null;
  name: string;
  baseModel: string;
  baseModelType: string;
  status: ModelStatus;
  availability: Availability;
  nsfwLevel: number;
  createdAt: Date;
  publishedAt: Date | null;
  trainingStatus: TrainingStatus | null;
  usageControl: ModelUsageControl;
  earlyAccessTimeFrame: number;
  requireAuth: boolean;
  generatorLoaded: boolean;
  flags: number;
  uploadType: ModelUploadType;
  fileCount: number;
  /** Files whose scan came back neither `Success` nor `Danger` — not yet cleared, not yet condemned. */
  unscannedFileCount: number;
  /** A DETECTED pickle or virus, kept apart from a file the scanner has not reached. */
  dangerFileCount: number;
  imageCount: number;
  /** `imageCount` hit the cap, so it is a floor rather than a total — render it with a `+`. */
  imageCountCapped: boolean;
  meta: unknown;
};

export type ModelReportRow = {
  id: number;
  reason: string;
  status: string;
  createdAt: Date;
  details: unknown;
  internalNotes: string | null;
  alsoReportedBy: number[] | null;
  previouslyReviewedCount: number | null;
  statusSetAt: Date | null;
  reportedById: number;
  reportedBy: string | null;
  statusSetById: number | null;
  statusSetBy: string | null;
};

export type ModelModActivityRow = {
  id: number;
  activity: string;
  createdAt: Date;
  moderatorId: number | null;
  moderatorUsername: string | null;
  /** Set when the action was filed against a VERSION rather than the model. */
  versionId: number | null;
};

export type ModelTagRow = { id: number; name: string; nsfwLevel: number };

// 🔴 No `imageCount`. Its source — `getImageTasks` in the main app's `model.metrics.ts` — is commented
// out, so the rollup only ever sums zeros. Under an "Aggregated <date>" line that zero reads as a fact;
// the per-version counts above answer the question instead.
export type ModelMetricRow = {
  downloadCount: number;
  generationCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  commentCount: number;
  collectedCount: number;
  tippedCount: number;
  tippedAmountCount: number;
  earnedAmount: number;
  updatedAt: Date;
};

export type ModelLookupResult = {
  model: ModelDetail;
  flag: ModelFlagRow | null;
  versions: ModelVersionRow[];
  reports: { rows: ModelReportRow[]; total: number };
  modActivity: { rows: ModelModActivityRow[]; truncated: boolean };
  tags: ModelTagRow[];
  metrics: ModelMetricRow | null;
  /** Usernames for the account ids buried in `meta` (`unpublishedBy`, `takenDownBy`, …) and `deletedBy`. */
  actors: Record<number, string>;
};

/**
 * What a search term named. `kind` is how it was named, not what it turned out to be — a term that
 * SAYS version is never re-read as a model, and vice versa; only `bare` is open to interpretation.
 */
export type ModelRef =
  | { kind: 'model'; modelId: number; versionId: number | null }
  | { kind: 'version'; versionId: number }
  | { kind: 'bare'; id: number };

/**
 * Four shapes reach the search box, and only one of them is ambiguous:
 *
 *   1234                                             → could be either id (see `resolveModelRefLive`)
 *   https://civitai.com/models/1234                  → model
 *   https://civitai.com/models/1234?modelVersionId=5 → model, version pinned
 *   https://civitai.com/model-versions/5             → version (a real main-app route, which redirects
 *                                                      to the model page — so a moderator investigating
 *                                                      a version genuinely holds one of these)
 *
 * Syntax only — `resolveModelRefLive` decides what a bare number is.
 */
export function resolveModelRef(term: string): ModelRef | null {
  const value = term.trim();
  if (!value) return null;

  // 🔴 Before the model rule: `/model-versions/5` also contains a digit run, and `/models/` is a
  // prefix of `/model-versions/` only by accident of spelling — reading it as a model id lands on a
  // real, unrelated row presented as the thing that was pasted.
  const versionUrlDigits = value.match(/\/model-versions\/(\d+)/)?.[1];
  if (versionUrlDigits) {
    const versionId = Number(versionUrlDigits);
    return isInt4Id(versionId) ? { kind: 'version', versionId } : null;
  }

  if (/^\d+$/.test(value)) {
    const id = Number(value);
    return isInt4Id(id) ? { kind: 'bare', id } : null;
  }

  const modelDigits = value.match(/\/models\/(\d+)/)?.[1];
  if (!modelDigits) return null;

  // `Model.id` is a Postgres integer: a larger value ERRORS the comparison rather than missing, so a
  // double-pasted id would 500 the page instead of finding nothing.
  const modelId = Number(modelDigits);
  if (!isInt4Id(modelId)) return null;

  const versionDigits = value.match(/[?&]modelVersionId=(\d+)/)?.[1];
  const versionId = versionDigits ? Number(versionDigits) : null;

  return { kind: 'model', modelId, versionId: versionId && isInt4Id(versionId) ? versionId : null };
}

export type ResolvedModelRef = {
  modelId: number;
  versionId: number | null;
  /** The term named a version and this is it — the page says so, because it is showing another row. */
  resolvedFromVersion: number | null;
  /** A bare id that is BOTH a model and a version. The model is shown; the page offers the other reading. */
  alsoAVersion: number | null;
};

const versionById = (versionId: number) =>
  dbRead
    .selectFrom('ModelVersion')
    .select(['id', 'modelId'])
    .where('id', '=', versionId)
    .executeTakeFirst();

/**
 * `resolveModelRef`, then the lookups that settle a bare number.
 *
 * 🔴 Model ids and version ids come from separate sequences whose ranges overlap across most of their
 * length, so a bare number is genuinely ambiguous and nothing in the string says which it is. This page
 * prints version ids in the same `#1234` style as the model id above them, so pasting one back into the
 * search box is the expected gesture rather than a slip.
 *
 * A bare id resolves model-first — that is the overwhelmingly common intent — then falls back to the
 * version. When it is BOTH, the model wins and `alsoAVersion` is set so the page can offer the other
 * reading instead of silently picking one. An id that a moderator got off a version row is otherwise
 * answered with a complete, confident page for an unrelated model.
 */
export async function resolveModelRefLive(term: string): Promise<ResolvedModelRef | null> {
  const ref = resolveModelRef(term);
  if (!ref) return null;

  if (ref.kind === 'model')
    return {
      modelId: ref.modelId,
      versionId: ref.versionId,
      resolvedFromVersion: null,
      alsoAVersion: null,
    };

  if (ref.kind === 'version') {
    const version = await versionById(ref.versionId);
    // Not found: keep the id so the page reports the VERSION the moderator named rather than a model
    // id they never typed.
    return version
      ? {
          modelId: version.modelId,
          versionId: version.id,
          resolvedFromVersion: version.id,
          alsoAVersion: null,
        }
      : null;
  }

  const [model, version] = await Promise.all([
    dbRead.selectFrom('Model').select('id').where('id', '=', ref.id).executeTakeFirst(),
    versionById(ref.id),
  ]);

  if (model)
    return {
      modelId: model.id,
      versionId: null,
      resolvedFromVersion: null,
      alsoAVersion: version ? version.id : null,
    };

  return version
    ? {
        modelId: version.modelId,
        versionId: version.id,
        resolvedFromVersion: version.id,
        alsoAVersion: null,
      }
    : { modelId: ref.id, versionId: null, resolvedFromVersion: null, alsoAVersion: null };
}

/**
 * 🔴 An ENUM array does not arrive as an array. node-postgres ships parsers for the built-in array
 * types — `text[]`, `int[]` — but not for an array of a user-defined enum, so `CommercialUse[]` comes
 * back as the raw literal `{Image,RentCivit}` while Kysely's generated types promise `CommercialUse[]`.
 * Nothing catches that: it typechecks, and the page 500s on `.join` the first time it renders.
 *
 * `lockedProperties` beside it is `text[]` and is genuinely parsed, which is what makes the pair
 * misleading. Any other enum-array column selected here needs the same treatment.
 */
export function parseEnumArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  const inner = value.replace(/^\{|\}$/g, '');
  return inner ? inner.split(',').map((v) => v.replace(/^"|"$/g, '')) : [];
}

async function getModel(modelId: number): Promise<ModelDetail | null> {
  const row = await dbRead
    .selectFrom('Model as m')
    .leftJoin('User as u', 'u.id', 'm.userId')
    .select((eb) => [
      'm.id',
      'm.name',
      'm.type',
      'm.status',
      'm.availability',
      'm.checkpointType',
      'm.uploadType',
      'm.mode',
      'm.createdAt',
      'm.updatedAt',
      'm.publishedAt',
      'm.lastVersionAt',
      'm.deletedAt',
      'm.deletedBy',
      'm.scannedAt',
      'm.nsfw',
      'm.nsfwLevel',
      'm.poi',
      'm.minor',
      'm.sfwOnly',
      'm.tosViolation',
      'm.locked',
      'm.lockedProperties',
      'm.unlisted',
      'm.underAttack',
      'm.isOfficial',
      'm.allowNoCredit',
      'm.allowCommercialUse',
      'm.allowDerivatives',
      'm.allowDifferentLicense',
      'm.meta',
      'm.userId',
      'u.username',
      'u.bannedAt as userBannedAt',
      eb.fn.coalesce(eb.fn<number>('length', ['m.description']), eb.lit(0)).as('descriptionLength'),
    ])
    .where('m.id', '=', modelId)
    .executeTakeFirst();

  return row
    ? ({
        ...row,
        allowCommercialUse: parseEnumArray(row.allowCommercialUse),
      } as unknown as ModelDetail)
    : null;
}

async function getFlag(modelId: number): Promise<ModelFlagRow | null> {
  const row = await dbRead
    .selectFrom('ModelFlag')
    .select([
      'poi',
      'minor',
      'sfwOnly',
      'nsfw',
      'triggerWords',
      'poiName',
      'status',
      'details',
      'createdAt',
    ])
    .where('modelId', '=', modelId)
    .executeTakeFirst();

  return (row as ModelFlagRow | undefined) ?? null;
}

const IMAGE_COUNT_CAP = 1000;

/** The same set Bulk Image Manager resolves (`imagesOfVersions` in `bulk-image.service.ts`) — posts
 *  alone is the showcase, and this number labels the link that opens the rest. Capped, so it is a
 *  floor; the panel renders it with a `+` rather than as a total. */
const IMAGES_OF_VERSION = sql`
  SELECT im."id" FROM "Image" im
  JOIN "Post" p ON p."id" = im."postId"
  WHERE p."modelVersionId" = mv."id"
  UNION
  SELECT irr."imageId" FROM "ImageResourceNew" irr
  WHERE irr."modelVersionId" = mv."id"
  LIMIT ${sql.lit(IMAGE_COUNT_CAP + 1)}
`;

// Correlated subqueries, not joins: joining files and images multiplies the rows before the aggregate,
// so every count is wrong for a version with more than one of each.
export async function getVersions(modelId: number): Promise<ModelVersionRow[]> {
  const rows = await dbRead
    .selectFrom('ModelVersion as mv')
    .select((eb) => [
      'mv.id',
      'mv.index',
      'mv.name',
      'mv.baseModel',
      'mv.baseModelType',
      'mv.status',
      'mv.availability',
      'mv.nsfwLevel',
      'mv.createdAt',
      'mv.publishedAt',
      'mv.trainingStatus',
      'mv.usageControl',
      'mv.earlyAccessTimeFrame',
      'mv.requireAuth',
      'mv.generatorLoaded',
      'mv.flags',
      'mv.uploadType',
      'mv.meta',
      eb
        .selectFrom('ModelFile as mf')
        .select(({ fn }) => fn.countAll<number>().as('c'))
        .whereRef('mf.modelVersionId', '=', 'mv.id')
        .where('mf.replacedAt', 'is', null)
        .as('fileCount'),
      eb
        .selectFrom('ModelFile as mf')
        .select(({ fn }) => fn.countAll<number>().as('c'))
        .whereRef('mf.modelVersionId', '=', 'mv.id')
        .where('mf.replacedAt', 'is', null)
        .where((inner) =>
          inner.or([
            inner.eb('mf.pickleScanResult', '=', 'Danger'),
            inner.eb('mf.virusScanResult', '=', 'Danger'),
          ])
        )
        .as('dangerFileCount'),
      eb
        .selectFrom('ModelFile as mf')
        .select(({ fn }) => fn.countAll<number>().as('c'))
        .whereRef('mf.modelVersionId', '=', 'mv.id')
        .where('mf.replacedAt', 'is', null)
        .where((inner) =>
          inner.or([
            inner.eb('mf.pickleScanResult', 'not in', ['Success', 'Danger']),
            inner.eb('mf.virusScanResult', 'not in', ['Success', 'Danger']),
          ])
        )
        .as('unscannedFileCount'),
      sql<number>`(SELECT count(*) FROM (${IMAGES_OF_VERSION}) u)`.as('imageCount'),
    ])
    .where('mv.modelId', '=', modelId)
    .orderBy('mv.index', 'asc')
    .orderBy('mv.id', 'desc')
    .execute();

  return rows.map((r) => ({
    ...r,
    fileCount: Number(r.fileCount ?? 0),
    unscannedFileCount: Number(r.unscannedFileCount ?? 0),
    dangerFileCount: Number(r.dangerFileCount ?? 0),
    imageCount: Math.min(Number(r.imageCount ?? 0), IMAGE_COUNT_CAP),
    imageCountCapped: Number(r.imageCount ?? 0) > IMAGE_COUNT_CAP,
  })) as unknown as ModelVersionRow[];
}

/** Newest reports, capped. The total is counted separately so the header can state it — a brigaded
 *  model carries thousands and the page holds one page of them. */
async function getReports(
  modelId: number,
  limit = 50
): Promise<{ rows: ModelReportRow[]; total: number }> {
  const totalRow = await dbRead
    .selectFrom('ModelReport')
    .select(({ fn }) => fn.countAll<number>().as('total'))
    .where('modelId', '=', modelId)
    .executeTakeFirst();
  const total = Number(totalRow?.total ?? 0);

  const rows = await dbRead
    .selectFrom('ModelReport as mr')
    .innerJoin('Report as r', 'r.id', 'mr.reportId')
    .select([
      'r.id',
      'r.reason',
      'r.status',
      'r.createdAt',
      'r.details',
      'r.internalNotes',
      'r.alsoReportedBy',
      'r.previouslyReviewedCount',
      'r.statusSetAt',
      'r.userId as reportedById',
      'r.statusSetBy as statusSetById',
    ])
    .where('mr.modelId', '=', modelId)
    .orderBy('r.createdAt', 'desc')
    .limit(limit)
    .execute();

  const byId = await usersByIds([
    ...rows.map((r) => r.reportedById),
    ...rows.map((r) => r.statusSetById ?? 0),
  ]);

  return {
    rows: rows.map((r) => ({
      ...r,
      reason: String(r.reason),
      status: String(r.status),
      reportedBy: byId.get(r.reportedById)?.username ?? null,
      statusSetBy: r.statusSetById ? byId.get(r.statusSetById)?.username ?? null : null,
    })) as ModelReportRow[],
    total,
  };
}

/**
 * 🔴 TWO entity types, not one. `declineReview` on a model version writes `entityType: 'modelVersion'`
 * against the VERSION id, so a model-only read reports "no recorded moderator activity" for a model
 * whose version was declined last week — the panel's most confident possible wrong answer.
 */
async function getModActivity(
  modelId: number,
  versionIds: number[],
  limit = 50
): Promise<{ rows: ModelModActivityRow[]; truncated: boolean }> {
  const [onModel, onVersions] = await Promise.all([
    getModActivityFor('model', [modelId], limit),
    getModActivityFor('modelVersion', versionIds, limit),
  ]);

  const merged = [...onModel.rows, ...onVersions.rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );

  return {
    rows: merged.slice(0, limit).map((r) => ({
      id: r.id,
      activity: r.activity,
      createdAt: r.createdAt,
      moderatorId: r.moderatorId,
      moderatorUsername: r.moderatorUsername,
      versionId: r.entityType === 'modelVersion' ? r.entityId : null,
    })),
    truncated: onModel.truncated || onVersions.truncated || merged.length > limit,
  };
}

async function getTags(modelId: number): Promise<ModelTagRow[]> {
  // `TagsOnModels` has no `automated`/`confidence`/`disabled` columns the way the image table does, so a
  // row says only that the tag is on the model.
  return dbRead
    .selectFrom('TagsOnModels as tom')
    .innerJoin('Tag as t', 't.id', 'tom.tagId')
    .select(['t.id', 't.name', 't.nsfwLevel'])
    .where('tom.modelId', '=', modelId)
    .orderBy('t.name', 'asc')
    .execute() as Promise<ModelTagRow[]>;
}

async function getMetrics(modelId: number): Promise<ModelMetricRow | null> {
  const row = await dbRead
    .selectFrom('ModelMetric')
    .select([
      'downloadCount',
      'generationCount',
      'thumbsUpCount',
      'thumbsDownCount',
      'commentCount',
      'collectedCount',
      'tippedCount',
      'tippedAmountCount',
      'earnedAmount',
      'updatedAt',
    ])
    .where('modelId', '=', modelId)
    .executeTakeFirst();

  return (row as ModelMetricRow | undefined) ?? null;
}

const ACTOR_META_KEYS = ['unpublishedBy', 'takenDownBy', 'archivedBy'] as const;

/** `Model.meta` is not always an object — see the note on `meta` in `ModelDetailPanel`. */
const asMetaRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const metaActorIds = (value: unknown): number[] => {
  const meta = asMetaRecord(value);
  return ACTOR_META_KEYS.map((key) => meta[key]).filter(
    (id): id is number => typeof id === 'number'
  );
};

export async function getModelLookup(modelId: number): Promise<ModelLookupResult | null> {
  const model = await getModel(modelId);
  if (!model) return null;

  // Versions first, and alone: the activity read needs their ids (moderator actions on a version are
  // filed against the VERSION), so it cannot join the batch below.
  const versions = await getVersions(modelId);

  const [flag, reports, modActivity, tags, metrics] = await Promise.all([
    getFlag(modelId),
    getReports(modelId),
    getModActivity(
      modelId,
      versions.map((v) => v.id)
    ),
    getTags(modelId),
    getMetrics(modelId),
  ]);

  const actorIds = [
    ...(model.deletedBy ? [model.deletedBy] : []),
    ...metaActorIds(model.meta),
    ...versions.flatMap((v) => metaActorIds(v.meta)),
  ];
  const actorRows = await usersByIds(actorIds);
  const actors = Object.fromEntries(
    [...actorRows].flatMap(([id, user]) => (user.username ? [[id, user.username] as const] : []))
  );

  return { model, flag, versions, reports, modActivity, tags, metrics, actors };
}
