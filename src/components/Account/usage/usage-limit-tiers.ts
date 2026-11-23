import type { UsageLimitTierEntry } from '~/server/services/usage-limit-config.service';
import type { UsageLimitTier } from '~/shared/constants/usage-limits';
import { numberWithCommas } from '~/utils/number-helpers';

const PAID_TIERS = ['bronze', 'silver', 'gold'] as const;

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** A plan-page line, e.g. "2x posts per day" or "15 gift claims of your links per month". */
export function planLimitText(entry: UsageLimitTierEntry, tier: string | undefined) {
  const own = entry.tiers[(tier ?? 'free') as UsageLimitTier];
  if (!own || own.limit <= entry.tiers.free.limit) return null;
  const label = lowerFirst(entry.label);
  return own.multiplier ? `${own.multiplier}x ${label}` : `${numberWithCommas(own.limit)} ${label}`;
}

/** What membership would raise this limit to, for a caller on the free tier; null otherwise. */
export function memberLimitNote(entry: UsageLimitTierEntry, tier: string | undefined) {
  if (tier && tier !== 'free') return null;
  const free = entry.tiers.free.limit;
  const paid = PAID_TIERS.map((t) => entry.tiers[t]).filter((t) => t.limit > free);
  if (!paid.length) return null;
  const multipliers = new Set(paid.map((t) => t.multiplier));
  if (multipliers.size === 1 && paid[0].multiplier) return `Members get ${paid[0].multiplier}x`;
  const limits = paid.map((t) => t.limit);
  const [low, high] = [Math.min(...limits), Math.max(...limits)];
  return low === high
    ? `Members get ${numberWithCommas(low)}`
    : `Members get ${numberWithCommas(low)} to ${numberWithCommas(high)}`;
}
