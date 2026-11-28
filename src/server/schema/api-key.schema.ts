import { TokenScope } from '~/shared/constants/token-scope.constants';
import * as z from 'zod';
import {
  DOCS_API_KEY_NAME_PREFIX,
  isReservedApiKeyName,
} from '~/shared/constants/docs-api-key.constants';

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

// The simple single-budget form and its mapping to `BuzzLimit` are shared with the auth hub's consent
// screen, so both write the same shape.
export {
  budgetsToSimpleBuzzLimit,
  simpleBuzzLimitToBudgets,
  type SimpleBuzzLimit,
} from '@civitai/auth/buzz-limit';

export const addApiKeyInputSchema = z.object({
  // Server-authoritative bound matching the UI input's maxLength (the name can be
  // seeded via the account deeplink, which bypasses the input's keystroke limit).
  name: z
    .string()
    .trim()
    .max(64)
    .refine((name) => !isReservedApiKeyName(name), {
      message: `Key names starting with "${DOCS_API_KEY_NAME_PREFIX}" are reserved for the developer docs`,
    }),
  // A number on the wire (JSON has no bigint), a bigint once parsed. Every bit is below 2^53.
  tokenScope: z
    .number()
    .int()
    .min(0)
    .max(Number(TokenScope.Full))
    .default(Number(TokenScope.Full))
    .transform((v) => BigInt(v)),
  buzzLimit: buzzLimitSchema.nullable().optional(),
});
export type AddAPIKeyInput = z.output<typeof addApiKeyInputSchema>;

export const setBuzzLimitInputSchema = z.object({
  id: z.number(),
  buzzLimit: buzzLimitSchema.nullable(),
});
export type SetBuzzLimitInput = z.infer<typeof setBuzzLimitInputSchema>;

export type SubjectType = 'apiKey' | 'oauth';
export type Subject = { type: 'apiKey'; id: number } | { type: 'oauth'; id: string };

export const deleteApiKeyInputSchema = z.object({ id: z.number() });
export type DeleteAPIKeyInput = z.infer<typeof deleteApiKeyInputSchema>;
