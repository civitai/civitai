import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type {
  LicensingFeeSettlementCurrency,
  LicensingFeeType,
  ModelType,
} from '~/shared/utils/prisma/enums';

export type BaseModelLicensingFeeRule = {
  baseModel: string;
  modelType: ModelType;
  recipientModelVersionId: number;
  recipientModelId: number;
  recipientModelName: string;
  amount: number;
  type: LicensingFeeType;
  settlementCurrency: LicensingFeeSettlementCurrency;
};

export type InheritedLicensingFee = Omit<BaseModelLicensingFeeRule, 'baseModel' | 'modelType'>;

type RuleRow = {
  baseModel: string;
  modelType: ModelType;
  recipientModelVersionId: number;
  recipientModelId: number;
  recipientModelName: string;
  licensingFee: number;
  licensingFeeType: LicensingFeeType | null;
  licensingFeeSettlementCurrency: LicensingFeeSettlementCurrency | null;
};

const CACHE_KEY = REDIS_KEYS.CACHES.BASE_MODEL_LICENSING_FEE_RULES;
const CACHE_TTL = CacheTTL.hour;

async function fetchRules(): Promise<BaseModelLicensingFeeRule[]> {
  const rows = await dbRead.$queryRaw<RuleRow[]>`
    SELECT
      bmlf."baseModel",
      bmlf."modelType",
      bmlf."modelVersionId" AS "recipientModelVersionId",
      rm.id                  AS "recipientModelId",
      rm.name                AS "recipientModelName",
      rmv."licensingFee",
      rmv."licensingFeeType",
      rmv."licensingFeeSettlementCurrency"
    FROM "BaseModelLicensingFee" bmlf
    JOIN "ModelVersion" rmv ON rmv.id = bmlf."modelVersionId"
    JOIN "Model" rm ON rm.id = rmv."modelId"
    WHERE rmv."licensingFee" IS NOT NULL AND rmv."licensingFee" > 0
  `;
  return rows.map((r) => ({
    baseModel: r.baseModel,
    modelType: r.modelType,
    recipientModelVersionId: r.recipientModelVersionId,
    recipientModelId: r.recipientModelId,
    recipientModelName: r.recipientModelName,
    amount: r.licensingFee,
    type: r.licensingFeeType ?? ('PerImageBuzz' as LicensingFeeType),
    settlementCurrency:
      r.licensingFeeSettlementCurrency ?? ('Buzz' as LicensingFeeSettlementCurrency),
  }));
}

export async function getBaseModelLicensingFeeRules(): Promise<BaseModelLicensingFeeRule[]> {
  const cached = await redis.packed.get<BaseModelLicensingFeeRule[]>(CACHE_KEY);
  if (cached) return cached;
  const rules = await fetchRules();
  await redis.packed.set(CACHE_KEY, rules, { EX: CACHE_TTL });
  return rules;
}

export async function bustBaseModelLicensingFeeCache() {
  await redis.del(CACHE_KEY);
}

export type LicensingFeeLookup = (
  baseModel: string,
  modelType: ModelType,
  versionId: number
) => InheritedLicensingFee | null;

export function buildLicensingFeeLookup(rules: BaseModelLicensingFeeRule[]): LicensingFeeLookup {
  const byKey = new Map<string, BaseModelLicensingFeeRule>();
  for (const r of rules) byKey.set(`${r.baseModel}:${r.modelType}`, r);
  return (baseModel, modelType, versionId) => {
    const rule = byKey.get(`${baseModel}:${modelType}`);
    if (!rule) return null;
    // Recipient version IS the source of the fee — surfaces its own fee instead
    // of "inherited from self" on the recipient's own detail page.
    if (rule.recipientModelVersionId === versionId) return null;
    return {
      recipientModelVersionId: rule.recipientModelVersionId,
      recipientModelId: rule.recipientModelId,
      recipientModelName: rule.recipientModelName,
      amount: rule.amount,
      type: rule.type,
      settlementCurrency: rule.settlementCurrency,
    };
  };
}
