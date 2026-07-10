import { dbRead } from '$lib/server/db';

export type CreatorModelVersion = {
  id: number;
  name: string;
  baseModel: string;
  status: string;
  publishedAt: Date | null;
  licensingFee: number | null;
  hasEarlyAccess: boolean;
};

export type CreatorModel = {
  id: number;
  name: string;
  type: string;
  status: string;
  versions: CreatorModelVersion[];
};

// The creator's models with versions nested (drafts included). Two queries + in-memory grouping rather than a
// json-agg so the columns stay typed against the schema.
export async function getCreatorModels(userId: number): Promise<CreatorModel[]> {
  const models = await dbRead
    .selectFrom('Model')
    .select(['id', 'name', 'type', 'status'])
    .where('userId', '=', userId)
    .where('deletedAt', 'is', null)
    .orderBy('lastVersionAt', 'desc')
    .execute();

  if (models.length === 0) return [];

  const versions = await dbRead
    .selectFrom('ModelVersion')
    .select(['id', 'modelId', 'name', 'baseModel', 'status', 'publishedAt', 'licensingFee', 'earlyAccessEndsAt'])
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
      // kysely types the DECIMAL column as string (prisma-kysely maps Decimal→string); the app carries it as a number.
      licensingFee: v.licensingFee == null ? null : Number(v.licensingFee),
      hasEarlyAccess: v.earlyAccessEndsAt !== null,
    });
    byModel.set(v.modelId, list);
  }

  return models.map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    status: m.status,
    versions: byModel.get(m.id) ?? [],
  }));
}
