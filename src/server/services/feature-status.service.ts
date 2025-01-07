import { dbWrite } from '~/server/db/client';
import {
  CreateFeatureStatusSchema,
  GetFeatureStatusPagedSchema,
  ResolveFeatureStatusSchema,
  featureStatusArray,
} from '../schema/feature-status.schema';
import { REDIS_KEYS, sysRedis } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';
import { signalClient } from '~/utils/signal-client';
import { SignalMessages } from '~/server/common/enums';

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
  const result = await dbWrite.featureStatus.create({
    data: { feature, disabled, message, createdBy: userId },
  });
  await sysRedis.packed.set(
    `${REDIS_KEYS.SYSTEM.FEATURE_STATUS}:${feature}`,
    {
      disabled: result.disabled,
      message: result.message,
    },
    { EX: CacheTTL.month }
  );
  await signalClient.send({ target: SignalMessages.FeatureStatus, data: { feature } });
}

export async function resolveFeatureStatus({
  id,
  resolved,
  userId,
}: ResolveFeatureStatusSchema & { userId: number }) {
  const result = await dbWrite.featureStatus.update({
    where: { id },
    data: { resolvedAt: resolved ? new Date() : null, resolvedBy: resolved ? userId : null },
  });
  await sysRedis.packed.set(
    `${REDIS_KEYS.SYSTEM.FEATURE_STATUS}:${result.feature}`,
    {
      disabled: result.disabled,
      message: !resolved ? result.message : null,
    },
    { EX: CacheTTL.month }
  );
  await signalClient.send({
    target: SignalMessages.FeatureStatus,
    data: { feature: result.feature },
  });
}

export async function getFeatureStatus() {
  const features = featureStatusArray;
  const cached = await sysRedis.packed
    .mGet<{ disabled: boolean; message: string | null }>(
      features.map((f) => `${REDIS_KEYS.SYSTEM.FEATURE_STATUS}:${f}`)
    )
    .then((data) => {
      if (data.filter(isDefined).length !== features.length) return null;
      return data.reduce<Record<string, { disabled: boolean; message: string }>>(
        (acc, val, index) => {
          if (!val || !val.message) return acc;
          return { ...acc, [features[index]]: { disabled: val.disabled, message: val.message } };
        },
        {}
      );
    });
  if (cached) return cached;

  const data = await dbWrite.featureStatus.findMany({
    distinct: ['feature'],
    orderBy: { createdAt: 'desc' },
    where: {
      feature: { in: [...features] },
    },
  });

  await Promise.all(
    data.map((status) =>
      sysRedis.packed.set(
        `${REDIS_KEYS.SYSTEM.FEATURE_STATUS}:${status.feature}`,
        {
          disabled: status.disabled,
          message: !status.resolvedAt ? status.message : null,
        },
        { EX: CacheTTL.month }
      )
    )
  );

  return data
    .filter((x) => !x.resolvedAt && x.message !== null)
    .reduce<Record<string, { disabled: boolean; message: string }>>(
      (acc, { feature, disabled, message }, index) => {
        return { ...acc, [feature[index]]: { feature, disabled, message } } as Record<
          string,
          { disabled: boolean; message: string }
        >;
      },
      {}
    );
}

export async function getFeatureStatusDistinct() {
  const data = await dbWrite.featureStatus.findMany({
    distinct: ['feature'],
    orderBy: { createdAt: 'desc' },
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
