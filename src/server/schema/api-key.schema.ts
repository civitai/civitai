import { TokenScope } from '~/shared/constants/token-scope.constants';
import * as z from 'zod';

export const getApiKeyInputSchema = z.object({ id: z.number() });
export type GetAPIKeyInput = z.infer<typeof getApiKeyInputSchema>;

export const getUserApiKeysInputSchema = z.object({
  skip: z.number().optional(),
  take: z.number().optional(),
});
export type GetUserAPIKeysInput = z.infer<typeof getUserApiKeysInputSchema>;

/**
 * Per-subject buzz spend budgets. The orchestrator owns enforcement; Civitai
 * stores budgets and exposes them on /api/v1/me. The shape is intentionally
 * flexible so we can grow into per-currency caps and calendar-rollover budgets
 * without another contract revision.
 *
 *  - `absolute` — hard cap with no time component. Optional `currencies` to
 *    restrict the cap to specific buzz pools.
 *  - `sliding`  — rolling window of `unit` × `window` (e.g. 7 day = rolling
 *    7-day window). What the simple UI ships today.
 *  - `rollover` — calendar-based reset driven by a cron expression.
 *
 * Civitai's UI today only exposes a single `sliding` budget (limit + period),
 * but the JSON column / API shape supports the full set so future surfaces
 * (custom-limit power user UI, programmatic clients) don't need a migration.
 */
export const slidingWindowEnum = z.enum(['second', 'minute', 'hour', 'day', 'week', 'month']);
export type SlidingWindow = z.infer<typeof slidingWindowEnum>;

const absoluteBudgetSchema = z.object({
  type: z.literal('absolute'),
  currencies: z.array(z.string()).optional(),
  limit: z.number().int().positive(),
});

const slidingBudgetSchema = z.object({
  type: z.literal('sliding'),
  currencies: z.array(z.string()).optional(),
  limit: z.number().int().positive(),
  window: slidingWindowEnum,
  unit: z.number().int().positive(),
});

const rolloverBudgetSchema = z.object({
  type: z.literal('rollover'),
  currencies: z.array(z.string()).optional(),
  limit: z.number().int().positive(),
  cron: z.string().min(1),
});

export const buzzBudgetSchema = z.discriminatedUnion('type', [
  absoluteBudgetSchema,
  slidingBudgetSchema,
  rolloverBudgetSchema,
]);
export type BuzzBudget = z.infer<typeof buzzBudgetSchema>;

/**
 * Per-subject buzz spend limit — an array of budgets. `null` (or column-null
 * in the JSONB) means no limit at all. An empty array also means no limit.
 */
export const buzzLimitSchema = z.array(buzzBudgetSchema);
export type BuzzLimit = z.infer<typeof buzzLimitSchema>;

/**
 * Simplified single-budget representation used by the current UI. Maps to a
 * `sliding` budget with the period collapsed onto a `day` window.
 */
export type SimpleBuzzLimit = {
  limit: number;
  period: 'day' | 'week' | 'month';
};

const PERIOD_DAYS: Record<SimpleBuzzLimit['period'], number> = {
  day: 1,
  week: 7,
  month: 30,
};

/**
 * Convert the UI's simple {limit, period} form into the canonical
 * `BuzzLimit` budgets array.
 */
export function simpleBuzzLimitToBudgets(simple: SimpleBuzzLimit | null): BuzzLimit | null {
  if (!simple) return null;
  return [
    {
      type: 'sliding',
      limit: simple.limit,
      window: 'day',
      unit: PERIOD_DAYS[simple.period],
    },
  ];
}

/**
 * Reverse mapping. Returns the simple representation if and only if the
 * budgets array is exactly one currency-unscoped sliding budget that matches
 * one of the simple periods. Otherwise null (treat as either "no limit" or
 * "custom" depending on caller).
 */
export function budgetsToSimpleBuzzLimit(
  budgets: BuzzLimit | null | undefined
): SimpleBuzzLimit | null {
  if (!budgets || budgets.length !== 1) return null;
  const b = budgets[0];
  if (b.type !== 'sliding') return null;
  if (b.currencies && b.currencies.length > 0) return null;

  if (b.window === 'day' && b.unit === 1) return { limit: b.limit, period: 'day' };
  if (b.window === 'day' && b.unit === 7) return { limit: b.limit, period: 'week' };
  if (b.window === 'day' && b.unit === 30) return { limit: b.limit, period: 'month' };
  if (b.window === 'week' && b.unit === 1) return { limit: b.limit, period: 'week' };
  if (b.window === 'month' && b.unit === 1) return { limit: b.limit, period: 'month' };
  return null;
}

export const addApiKeyInputSchema = z.object({
  // Server-authoritative bound matching the UI input's maxLength (the name can be
  // seeded via the account deeplink, which bypasses the input's keystroke limit).
  name: z.string().trim().max(64),
  tokenScope: z.number().int().min(0).max(TokenScope.Full).default(TokenScope.Full),
  buzzLimit: buzzLimitSchema.nullable().optional(),
});
export type AddAPIKeyInput = z.input<typeof addApiKeyInputSchema>;

export const setBuzzLimitInputSchema = z.object({
  id: z.number(),
  buzzLimit: buzzLimitSchema.nullable(),
});
export type SetBuzzLimitInput = z.infer<typeof setBuzzLimitInputSchema>;

export type SubjectType = 'apiKey' | 'oauth';
export type Subject = { type: 'apiKey'; id: number } | { type: 'oauth'; id: string };

export const deleteApiKeyInputSchema = z.object({ id: z.number() });
export type DeleteAPIKeyInput = z.infer<typeof deleteApiKeyInputSchema>;
