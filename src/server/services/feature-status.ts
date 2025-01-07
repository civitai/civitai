import { dbWrite } from '~/server/db/client';
import {
  CreateFeatureStatusSchema,
  GetFeatureStatusPagedSchema,
  GetFeatureStatusSchema,
  ResolveFeatureStatusSchema,
} from '../schema/feature-status.schema';

export type FeatureStatus = {
  id: number;
  feature: string;
  disabled?: boolean;
  message?: string;
  resolvedAt?: Date;
  resolvedBy?: number;
  createdAt: Date;
  createdBy: number;
};

export async function createFeatureStatus({
  feature,
  disabled,
  message,
  userId,
}: CreateFeatureStatusSchema & { userId: number }) {
  return await dbWrite.featureStatus.create({
    data: { feature, disabled, message, createdBy: userId },
  });
}

export async function resolveFeatureStatus({
  id,
  resolved,
  userId,
}: ResolveFeatureStatusSchema & { userId: number }) {
  return await dbWrite.featureStatus.update({
    where: { id },
    data: { resolvedAt: resolved ? new Date() : null, resolvedBy: resolved ? userId : null },
  });
}

export async function getFeatureStatus({ feature }: GetFeatureStatusSchema) {
  const data = await dbWrite.featureStatus.findMany({
    distinct: ['feature'],
    orderBy: { createdAt: 'desc' },
    where: {
      feature: feature.length ? { in: feature } : undefined,
    },
  });

  return data.filter((x) => x.resolvedAt === null) as FeatureStatus[];
}

export async function getFeatureStatusDistinct({ feature }: GetFeatureStatusSchema) {
  const data = await dbWrite.featureStatus.findMany({
    distinct: ['feature'],
    orderBy: { createdAt: 'desc' },
    where: {
      feature: feature.length ? { in: feature } : undefined,
    },
  });

  return data as FeatureStatus[];
}

export async function getFeatureStatusInfinite({
  feature,
  cursor,
  limit,
}: GetFeatureStatusPagedSchema) {
  const items = await dbWrite.featureStatus.findMany({
    where: { feature },
    cursor: cursor ? { id: cursor } : undefined,
    take: limit + 1,
    orderBy: { createdAt: 'desc' },
  });

  let nextCursor: number | undefined;
  if (limit && items.length > limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  return { items, nextCursor };
}
