import type { Refusal } from './server/shop/purchase';
import { count } from './format';

/** What the shop says when a purchase is refused. Only wording: the server decided. */
export function refusalText(
  reason: Refusal,
  { shortfall, minRank }: { shortfall?: number; minRank?: string | null } = {}
): string {
  switch (reason) {
    case 'no-player':
      return 'You have not joined the Order yet.';
    case 'held':
      return 'Spending is paused while your account is reviewed. Your gold is kept, not lost.';
    case 'closed':
      return "Buzz packs aren't available right now. Your gold is untouched.";
    case 'unknown-item':
    case 'not-in-stock':
      return 'That is not on sale today.';
    case 'price-changed':
      return "The price has changed since you opened the shop. Reload to see today's price.";
    case 'rank':
      return minRank ? `This unlocks at ${minRank}.` : 'This is not open to your rank yet.';
    case 'sold-out':
      return 'Gone for today. New stock arrives at midnight UTC.';
    case 'owned':
      return 'You already own this.';
    case 'unlimited':
      return 'You already have unlimited uses of this sticker.';
    case 'insufficient':
      return `${count(shortfall ?? 0)} gold short.`;
    case 'bad-key':
      return 'That purchase could not be started. Try again.';
  }
}

export const REFUSAL_STATUS: Record<Refusal, number> = {
  'no-player': 409,
  held: 403,
  closed: 403,
  'unknown-item': 404,
  'not-in-stock': 409,
  'price-changed': 409,
  rank: 403,
  'sold-out': 409,
  owned: 409,
  unlimited: 409,
  insufficient: 409,
  'bad-key': 400,
};

const TIER = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold' } as const;
export const tierName = (tier: string | null) =>
  tier && tier in TIER ? TIER[tier as keyof typeof TIER] : tier ?? '';

export const monthsLabel = (months: number | null) =>
  months === 1 ? '1 month' : `${months ?? 0} months`;
