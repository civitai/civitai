import { sql } from '@civitai/db/kysely';
import { dbRead } from '$lib/server/db';
import type { ModelType } from '@civitai/db-schema';
import type { ModelVersionTerms } from '@civitai/buzz';
import {
  DEFAULT_GENERATION_TRIAL_LIMIT,
  type PaidAccessConfig,
} from '$lib/monetization/paid-access';

// "Sold in any form": an active PaidAccess row — a timed window still open OR a permanent (no end date) gate.
function paidAccessFilter(alias: string) {
  const p = sql.raw(`${alias}.`);
  return sql<boolean>`exists (select 1 from "PaidAccess" pa where pa."entityType" = 'ModelVersion' and pa."entityId" = ${p}"id" and (pa."endsAt" is null or pa."endsAt" > now()))`;
}

// Rebuild the UI-facing PaidAccessConfig from an active PaidAccess row (terms bundle + timeframeDays).
// timeframeDays null => permanent. Donation-goal fields are sourced separately, not from PaidAccess.
function paidAccessToConfig(timeframeDays: number | null, terms: unknown): PaidAccessConfig | null {
  const t = terms as ModelVersionTerms | null;
  if (!t) return null;
  const gen = t.generation;
  const paidGen = gen && !('free' in gen) ? gen : undefined;
  // "Price for access" is the download price when downloadable; for a gen-only version (no download tier)
  // it's the generation price. The separate generation-only tier only exists alongside a download bundle.
  return {
    timeframe: timeframeDays ?? 0,
    permanent: timeframeDays == null,
    accessPrice: t.download?.price ?? paidGen?.price,
    generationPrice: t.download ? paidGen?.price : undefined,
    freeGeneration: !!gen && 'free' in gen,
    freePreviewGenerations: paidGen?.trialLimit ?? DEFAULT_GENERATION_TRIAL_LIMIT,
    donationGoalEnabled: false,
    donationGoal: undefined,
  };
}

export type CreatorModelVersion = {
  id: number;
  name: string;
  baseModel: string;
  status: string;
  publishedAt: Date | null;
  licensingFee: number | null;
  // Governs whether the version can be gated: Download (download + gen), Generation (on-site gen only,
  // no download charge), or other (no paid access). See paidAccessUsageOk in the models page.
  usageControl: string;
  hasPaidAccess: boolean;
  paidAccessConfig: PaidAccessConfig | null;
};

export type CreatorModel = {
  id: number;
  name: string;
  type: string;
  status: string;
  // Drive the "view on Civitai" link to civitai.red vs civitai.com (see $lib/model-url).
  nsfw: boolean;
  nsfwLevel: number;
  versions: CreatorModelVersion[];
};

export type ModelsSort = 'recent' | 'name';
export type FeeFilter = 'set' | 'off';
// Default (undefined) hides drafts (M3); 'all' shows them, 'published'/'draft' narrow to one.
export type StatusFilter = 'all' | 'published' | 'draft';

export type ModelsQuery = {
  userId: number;
  q?: string;
  fee?: FeeFilter;
  baseModel?: string;
  /** Model type (Checkpoint / LORA / …) — a Model-level filter (868ke491e). */
  type?: string;
  status?: StatusFilter;
  access?: boolean; // has early / paid access on a version
  /** Usage-control filter (bulk paid-access scoping): 'download' or 'generation'. */
  usage?: 'download' | 'generation';
  sort?: ModelsSort;
  page?: number;
  /** Rows per page (defaults to MODELS_PER_PAGE); the page's cookie-backed size selector sets it. */
  perPage?: number;
  /** Also compute the full matching version-id set for bulk "select all" (only needed in bulk mode). */
  withMatchingVersionIds?: boolean;
};

export type CreatorModelsResult = {
  models: CreatorModel[];
  total: number;
  page: number;
  pageCount: number;
  baseModels: string[];
  modelTypes: string[];
  matchingVersionIds: number[];
};

// Flat per-version row for the CSV fee round-trip — the creator's versions matching the current filters, with the
// fields the sheet shows (id is the immutable join key on re-upload).
export type CsvVersionRow = {
  versionId: number;
  modelName: string;
  versionName: string;
  baseModel: string;
  modelType: string;
  licensingFee: number | null;
};

// Every version matching the page's filters (no pagination) for CSV export. Mirrors getCreatorModels' filters so
// "export" matches what the creator is currently looking at.
export async function getCreatorVersionsForCsv(query: ModelsQuery): Promise<CsvVersionRow[]> {
  const { userId, q, fee, baseModel, type, status, access } = query;
  let qb = dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .where('m.userId', '=', userId)
    .where('m.deletedAt', 'is', null);
  if (q) qb = qb.where('m.name', 'ilike', `%${q}%`);
  if (type) qb = qb.where('m.type', '=', type as ModelType);
  if (status === 'published') qb = qb.where('m.status', '=', 'Published');
  else if (status === 'draft') qb = qb.where('m.status', '=', 'Draft');
  else if (status !== 'all') qb = qb.where('m.status', '!=', 'Draft');
  if (baseModel) qb = qb.where('mv.baseModel', '=', baseModel);
  if (access) qb = qb.where(paidAccessFilter('mv'));
  if (fee === 'set') qb = qb.where('mv.licensingFee', 'is not', null);
  if (fee === 'off') qb = qb.where('mv.licensingFee', 'is', null);
  const rows = await qb
    .select([
      'mv.id as versionId',
      'mv.name as versionName',
      'mv.baseModel as baseModel',
      'm.name as modelName',
      'm.type as modelType',
      'mv.licensingFee as licensingFee',
    ])
    .orderBy('m.name', 'asc')
    .orderBy('mv.index', 'asc')
    .execute();
  return rows.map((r) => ({
    versionId: r.versionId,
    modelName: r.modelName,
    versionName: r.versionName,
    baseModel: r.baseModel,
    modelType: r.modelType,
    licensingFee: r.licensingFee == null ? null : Number(r.licensingFee),
  }));
}

export const MODELS_PER_PAGE = 20;
// Cookie-backed page-size options shared across paged Studio surfaces (868ke493p).
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
export const PAGE_SIZE_COOKIE = 'cs-page-size';

// The creator's models with versions nested, filterable by search / fee / base model / status / access, with
// sort + pagination. Version-level filters (fee/baseModel/access) both narrow the model list (models with ≥1
// matching version) AND restrict the versions shown, so "select all" selects exactly what's on screen.
export async function getCreatorModels(query: ModelsQuery): Promise<CreatorModelsResult> {
  const { userId, q, fee, baseModel, type, status, access, usage, sort = 'recent' } = query;
  const page = Math.max(1, query.page ?? 1);
  const perPage = query.perPage ?? MODELS_PER_PAGE;
  const usageValue =
    usage === 'generation' ? 'Generation' : usage === 'download' ? 'Download' : null;

  // Model-list filter (shared by count + page query; kysely builders are immutable, so branch off one).
  let filtered = dbRead
    .selectFrom('Model')
    .where('userId', '=', userId)
    .where('deletedAt', 'is', null);
  if (q) filtered = filtered.where('name', 'ilike', `%${q}%`);
  if (type) filtered = filtered.where('type', '=', type as ModelType);
  if (status === 'published') filtered = filtered.where('status', '=', 'Published');
  else if (status === 'draft') filtered = filtered.where('status', '=', 'Draft');
  else if (status !== 'all') filtered = filtered.where('status', '!=', 'Draft'); // default: hide drafts
  const hasVersionFilter = !!baseModel || !!access || !!fee || !!usageValue;
  if (hasVersionFilter)
    filtered = filtered.where((eb) =>
      eb.exists(
        eb
          .selectFrom('ModelVersion as mv')
          .select('mv.id')
          .whereRef('mv.modelId', '=', 'Model.id')
          .$if(!!baseModel, (b) => b.where('mv.baseModel', '=', baseModel!))
          .$if(!!access, (b) => b.where(paidAccessFilter('mv')))
          .$if(!!usageValue, (b) => b.where('mv.usageControl', '=', usageValue!))
          .$if(fee === 'set', (b) => b.where('mv.licensingFee', 'is not', null))
          .$if(fee === 'off', (b) => b.where('mv.licensingFee', 'is', null))
      )
    );

  const [totalRow, models, baseModelRows, modelTypeRows] = await Promise.all([
    filtered.select((eb) => eb.fn.countAll().as('count')).executeTakeFirst(),
    filtered
      .select(['id', 'name', 'type', 'status', 'nsfw', 'nsfwLevel'])
      .orderBy(sort === 'name' ? 'name' : 'lastVersionAt', sort === 'name' ? 'asc' : 'desc')
      .limit(perPage)
      .offset((page - 1) * perPage)
      .execute(),
    // Distinct base models the creator actually has — the base-model filter options.
    dbRead
      .selectFrom('ModelVersion as mv')
      .innerJoin('Model as m', 'm.id', 'mv.modelId')
      .where('m.userId', '=', userId)
      .where('m.deletedAt', 'is', null)
      .select('mv.baseModel')
      .distinct()
      .orderBy('mv.baseModel', 'asc')
      .execute(),
    // Distinct model types the creator has — the model-type filter options (868ke491e).
    dbRead
      .selectFrom('Model')
      .where('userId', '=', userId)
      .where('deletedAt', 'is', null)
      .select('type')
      .distinct()
      .orderBy('type', 'asc')
      .execute(),
  ]);
  const total = Number(totalRow?.count ?? 0);
  const baseModels = baseModelRows.map((r) => r.baseModel).filter(Boolean);
  const modelTypes = modelTypeRows.map((r) => r.type).filter(Boolean);

  const pageCount = Math.max(1, Math.ceil(total / perPage));
  if (models.length === 0)
    return { models: [], total, page, pageCount, baseModels, modelTypes, matchingVersionIds: [] };

  const versions = await dbRead
    .selectFrom('ModelVersion as mv')
    .leftJoin('PaidAccess as pa', (join) =>
      join
        .onRef('pa.entityId', '=', 'mv.id')
        .on('pa.entityType', '=', 'ModelVersion')
        .on((eb) => eb.or([eb('pa.endsAt', 'is', null), eb('pa.endsAt', '>', new Date())]))
    )
    .leftJoin('DonationGoal as dg', (join) =>
      join.onRef('dg.entityId', '=', 'mv.id').on('dg.entityType', '=', 'ModelVersion')
    )
    .select([
      'mv.id',
      'mv.modelId',
      'mv.name',
      'mv.baseModel',
      'mv.status',
      'mv.publishedAt',
      'mv.licensingFee',
      'mv.usageControl',
      'pa.timeframeDays as paTimeframeDays',
      'pa.terms as paTerms',
      'dg.goalAmount as donationGoalAmount',
    ])
    .where(
      'mv.modelId',
      'in',
      models.map((m) => m.id)
    )
    .$if(!!baseModel, (b) => b.where('mv.baseModel', '=', baseModel!))
    .$if(!!access, (b) => b.where(paidAccessFilter('mv')))
    .$if(!!usageValue, (b) => b.where('mv.usageControl', '=', usageValue!))
    .$if(fee === 'set', (b) => b.where('mv.licensingFee', 'is not', null))
    .$if(fee === 'off', (b) => b.where('mv.licensingFee', 'is', null))
    .orderBy('mv.index', 'asc')
    .execute();

  // Select-all set: every version matching the filter across ALL pages (bulk mode only — it can be large).
  let matchingVersionIds: number[] = [];
  if (query.withMatchingVersionIds) {
    const idRows = await dbRead
      .selectFrom('ModelVersion as mv')
      .innerJoin('Model as m', 'm.id', 'mv.modelId')
      .where('m.userId', '=', userId)
      .where('m.deletedAt', 'is', null)
      .$if(!!q, (b) => b.where('m.name', 'ilike', `%${q}%`))
      .$if(!!type, (b) => b.where('m.type', '=', type as ModelType))
      .$if(status === 'published', (b) => b.where('m.status', '=', 'Published'))
      .$if(status === 'draft', (b) => b.where('m.status', '=', 'Draft'))
      .$if(!status || (status !== 'all' && status !== 'published' && status !== 'draft'), (b) =>
        b.where('m.status', '!=', 'Draft')
      )
      .$if(!!baseModel, (b) => b.where('mv.baseModel', '=', baseModel!))
      .$if(!!access, (b) => b.where(paidAccessFilter('mv')))
      .$if(!!usageValue, (b) => b.where('mv.usageControl', '=', usageValue!))
      .$if(fee === 'set', (b) => b.where('mv.licensingFee', 'is not', null))
      .$if(fee === 'off', (b) => b.where('mv.licensingFee', 'is', null))
      .select('mv.id')
      .execute();
    matchingVersionIds = idRows.map((r) => r.id);
  }

  const byModel = new Map<number, CreatorModelVersion[]>();
  for (const v of versions) {
    const list = byModel.get(v.modelId) ?? [];
    // The left join only matched an ACTIVE gate, so a rebuilt config means the version is currently sold.
    const paidAccessConfig = paidAccessToConfig(v.paTimeframeDays, v.paTerms);
    // A donation goal (create-once, timed-only) is a separate row from the gate — fold the existing one
    // into the config so the editor reflects it. Permanent gates never carry a goal.
    if (paidAccessConfig && !paidAccessConfig.permanent && v.donationGoalAmount != null) {
      paidAccessConfig.donationGoalEnabled = true;
      paidAccessConfig.donationGoal = Number(v.donationGoalAmount);
    }
    list.push({
      id: v.id,
      name: v.name,
      baseModel: v.baseModel,
      status: v.status,
      publishedAt: v.publishedAt,
      // kysely types the DECIMAL column as string (prisma-kysely maps Decimal→string); the app carries a number.
      licensingFee: v.licensingFee == null ? null : Number(v.licensingFee),
      usageControl: v.usageControl,
      hasPaidAccess: paidAccessConfig !== null,
      paidAccessConfig,
    });
    byModel.set(v.modelId, list);
  }

  return {
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      status: m.status,
      nsfw: !!m.nsfw,
      nsfwLevel: Number(m.nsfwLevel ?? 0),
      versions: byModel.get(m.id) ?? [],
    })),
    total,
    page,
    pageCount,
    baseModels,
    modelTypes,
    matchingVersionIds,
  };
}
