import { dbRead } from '$lib/server/db';
import type { EarlyAccessConfig } from '$lib/monetization/early-access';

// The `earlyAccessConfig` column is `{}` (or JSON null) for versions that never configured early access.
// Only treat it as a real config when it actually carries the timeframe an EA setup always writes.
function isRealEarlyAccessConfig(value: unknown): value is EarlyAccessConfig {
  return !!value && typeof value === 'object' && 'timeframe' in value;
}

export type CreatorModelVersion = {
  id: number;
  name: string;
  baseModel: string;
  status: string;
  publishedAt: Date | null;
  licensingFee: number | null;
  hasEarlyAccess: boolean;
  earlyAccessConfig: EarlyAccessConfig | null;
};

export type CreatorModel = {
  id: number;
  name: string;
  type: string;
  status: string;
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
  status?: StatusFilter;
  access?: boolean; // has early / paid access on a version
  sort?: ModelsSort;
  page?: number;
  /** Also compute the full matching version-id set for bulk "select all" (only needed in bulk mode). */
  withMatchingVersionIds?: boolean;
};

export type CreatorModelsResult = {
  models: CreatorModel[];
  total: number;
  page: number;
  pageCount: number;
  baseModels: string[];
  matchingVersionIds: number[];
};

export const MODELS_PER_PAGE = 20;

// The creator's models with versions nested, filterable by search / fee / base model / status / access, with
// sort + pagination. Version-level filters (fee/baseModel/access) both narrow the model list (models with ≥1
// matching version) AND restrict the versions shown, so "select all" selects exactly what's on screen.
export async function getCreatorModels(query: ModelsQuery): Promise<CreatorModelsResult> {
  const { userId, q, fee, baseModel, status, access, sort = 'recent' } = query;
  const page = Math.max(1, query.page ?? 1);
  const perPage = MODELS_PER_PAGE;

  // Model-list filter (shared by count + page query; kysely builders are immutable, so branch off one).
  let filtered = dbRead
    .selectFrom('Model')
    .where('userId', '=', userId)
    .where('deletedAt', 'is', null);
  if (q) filtered = filtered.where('name', 'ilike', `%${q}%`);
  if (status === 'published') filtered = filtered.where('status', '=', 'Published');
  else if (status === 'draft') filtered = filtered.where('status', '=', 'Draft');
  else if (status !== 'all') filtered = filtered.where('status', '!=', 'Draft'); // default: hide drafts
  const hasVersionFilter = !!baseModel || !!access || !!fee;
  if (hasVersionFilter)
    filtered = filtered.where((eb) =>
      eb.exists(
        eb
          .selectFrom('ModelVersion as mv')
          .select('mv.id')
          .whereRef('mv.modelId', '=', 'Model.id')
          .$if(!!baseModel, (b) => b.where('mv.baseModel', '=', baseModel!))
          .$if(!!access, (b) => b.where('mv.earlyAccessEndsAt', 'is not', null))
          .$if(fee === 'set', (b) => b.where('mv.licensingFee', 'is not', null))
          .$if(fee === 'off', (b) => b.where('mv.licensingFee', 'is', null))
      )
    );

  const [totalRow, models, baseModelRows] = await Promise.all([
    filtered.select((eb) => eb.fn.countAll().as('count')).executeTakeFirst(),
    filtered
      .select(['id', 'name', 'type', 'status'])
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
  ]);
  const total = Number(totalRow?.count ?? 0);
  const baseModels = baseModelRows.map((r) => r.baseModel).filter(Boolean);

  const pageCount = Math.max(1, Math.ceil(total / perPage));
  if (models.length === 0)
    return { models: [], total, page, pageCount, baseModels, matchingVersionIds: [] };

  const versions = await dbRead
    .selectFrom('ModelVersion')
    .select([
      'id',
      'modelId',
      'name',
      'baseModel',
      'status',
      'publishedAt',
      'licensingFee',
      'earlyAccessEndsAt',
      'earlyAccessConfig',
    ])
    .where(
      'modelId',
      'in',
      models.map((m) => m.id)
    )
    .$if(!!baseModel, (b) => b.where('baseModel', '=', baseModel!))
    .$if(!!access, (b) => b.where('earlyAccessEndsAt', 'is not', null))
    .$if(fee === 'set', (b) => b.where('licensingFee', 'is not', null))
    .$if(fee === 'off', (b) => b.where('licensingFee', 'is', null))
    .orderBy('index', 'asc')
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
      .$if(status === 'published', (b) => b.where('m.status', '=', 'Published'))
      .$if(status === 'draft', (b) => b.where('m.status', '=', 'Draft'))
      .$if(!status || (status !== 'all' && status !== 'published' && status !== 'draft'), (b) =>
        b.where('m.status', '!=', 'Draft')
      )
      .$if(!!baseModel, (b) => b.where('mv.baseModel', '=', baseModel!))
      .$if(!!access, (b) => b.where('mv.earlyAccessEndsAt', 'is not', null))
      .$if(fee === 'set', (b) => b.where('mv.licensingFee', 'is not', null))
      .$if(fee === 'off', (b) => b.where('mv.licensingFee', 'is', null))
      .select('mv.id')
      .execute();
    matchingVersionIds = idRows.map((r) => r.id);
  }

  const byModel = new Map<number, CreatorModelVersion[]>();
  for (const v of versions) {
    const list = byModel.get(v.modelId) ?? [];
    list.push({
      id: v.id,
      name: v.name,
      baseModel: v.baseModel,
      status: v.status,
      publishedAt: v.publishedAt,
      // kysely types the DECIMAL column as string (prisma-kysely maps Decimal→string); the app carries a number.
      licensingFee: v.licensingFee == null ? null : Number(v.licensingFee),
      hasEarlyAccess: v.earlyAccessEndsAt !== null,
      // The column defaults to an empty object `{}` (or JSON null) for versions that never set up early
      // access — treat those as "no config" so the UI doesn't show every version as configured.
      earlyAccessConfig: isRealEarlyAccessConfig(v.earlyAccessConfig)
        ? (v.earlyAccessConfig as EarlyAccessConfig)
        : null,
    });
    byModel.set(v.modelId, list);
  }

  return {
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      status: m.status,
      versions: byModel.get(m.id) ?? [],
    })),
    total,
    page,
    pageCount,
    baseModels,
    matchingVersionIds,
  };
}
