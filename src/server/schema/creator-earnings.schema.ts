import * as z from 'zod';

export const earningsWindowSchema = z.enum(['30d']).default('30d');
export type EarningsWindow = z.infer<typeof earningsWindowSchema>;

export const modelPerformanceSortSchema = z.enum(['buzzEarned', 'jobsCount']).default('buzzEarned');
export type ModelPerformanceSort = z.infer<typeof modelPerformanceSortSchema>;

export const getEarningsThisMonthSchema = z.object({}).default({});

export type GetModelPerformanceInput = z.infer<typeof getModelPerformanceSchema>;
export const getModelPerformanceSchema = z.object({
  window: earningsWindowSchema,
  sortBy: modelPerformanceSortSchema,
});

export type GetSourceMixInput = z.infer<typeof getSourceMixSchema>;
export const getSourceMixSchema = z.object({
  window: earningsWindowSchema,
});

export type EarningSource = 'creatorsTip' | 'tipConfirm' | 'ea' | 'bounty' | 'other';

export type EarningsBreakdown = {
  creatorsTip: number;
  tipConfirm: number;
  ea: number;
  bounty: number;
  other: number;
};

export type EarningsThisMonth = {
  currentMonth: {
    totalBuzz: number;
    usdEquivalent: number;
    breakdown: EarningsBreakdown;
  };
  priorMonth: {
    totalBuzz: number;
    usdEquivalent: number;
    breakdown: EarningsBreakdown;
  };
};

export type ModelTrend = 'up' | 'down' | 'flat' | 'dead';

export type ModelPerformanceRow = {
  modelId: number;
  modelName: string;
  modelType: string;
  jobsCount: number;
  buzzEarned: number;
  trend: ModelTrend;
  eaEnabled: boolean;
};

export type SourceMixRow = {
  source: EarningSource;
  buzz: number;
  pct: number;
};
