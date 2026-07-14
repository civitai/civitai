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

export type ModelsQuery = {
  userId: number;
  q?: string;
  fee?: FeeFilter;
  sort?: ModelsSort;
  page?: number;
};

export type CreatorModelsResult = {
  models: CreatorModel[];
  total: number;
  page: number;
  pageCount: number;
};

export const MODELS_PER_PAGE = 20;

// The creator's models with versions nested (drafts included), with URL-driven search / fee filter / sort /
// pagination. Two queries + in-memory grouping so the columns stay typed against the schema.
export async function getCreatorModels(query: ModelsQuery): Promise<CreatorModelsResult> {
  const { userId, q, fee, sort = 'recent' } = query;
  const page = Math.max(1, query.page ?? 1);
  const perPage = MODELS_PER_PAGE;

  // Filters shared between the count and the page query (kysely builders are immutable, so we branch off one).
  let filtered = dbRead
    .selectFrom('Model')
    .where('userId', '=', userId)
    .where('deletedAt', 'is', null);
  if (q) filtered = filtered.where('name', 'ilike', `%${q}%`);
  if (fee === 'set')
    filtered = filtered.where((eb) =>
      eb.exists(
        eb
          .selectFrom('ModelVersion as mv')
          .select('mv.id')
          .whereRef('mv.modelId', '=', 'Model.id')
          .where('mv.licensingFee', 'is not', null)
      )
    );
  if (fee === 'off')
    filtered = filtered.where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('ModelVersion as mv')
            .select('mv.id')
            .whereRef('mv.modelId', '=', 'Model.id')
            .where('mv.licensingFee', 'is not', null)
        )
      )
    );

  const totalRow = await filtered.select((eb) => eb.fn.countAll().as('count')).executeTakeFirst();
  const total = Number(totalRow?.count ?? 0);

  const models = await filtered
    .select(['id', 'name', 'type', 'status'])
    .orderBy(sort === 'name' ? 'name' : 'lastVersionAt', sort === 'name' ? 'asc' : 'desc')
    .limit(perPage)
    .offset((page - 1) * perPage)
    .execute();

  const pageCount = Math.max(1, Math.ceil(total / perPage));
  if (models.length === 0) return { models: [], total, page, pageCount };

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
    .orderBy('index', 'asc')
    .execute();

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
  };
}
