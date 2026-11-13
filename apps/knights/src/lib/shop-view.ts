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
    case 'not-approved':
      return 'This item is still being reviewed, so it is not on sale yet. Your gold is untouched.';
    case 'insufficient':
      return `${count(shortfall ?? 0)} gold short.`;
    case 'has-membership':
      return 'You already have a membership. You can buy a week once it has ended.';
    case 'bad-key':
      return 'That purchase could not be started. Try again.';
  }
}

export type BuyClick =
  | { kind: 'refused'; text: string }
  | { kind: 'short'; by: number }
  | { kind: 'confirm' };

/** What a Buy click does before any request: a held player gets the refusal the server would send, a short purse the gap. */
export function buyClick(balance: { held: boolean; convertible: number }, price: number): BuyClick {
  if (balance.held) return { kind: 'refused', text: refusalText('held') };
  if (balance.convertible < price) return { kind: 'short', by: price - balance.convertible };
  return { kind: 'confirm' };
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
  'not-approved': 409,
  insufficient: 409,
  'has-membership': 409,
  'bad-key': 400,
};

/** Percent off the list price, never negative and never NaN for a list price of 0. */
export const dealPercentOff = (price: number, listPrice: number) =>
  listPrice > 0 ? Math.max(0, Math.round((1 - price / listPrice) * 100)) : 0;

/**
 * How much more Buzz a pack gives than its list price buys at the base rate, in whole percent.
 * Rounded down so the label never overstates; a deal's discount is shown on its own tag.
 */
export const packBonusPercent = (buzz: number | null, listPrice: number, goldPerBuzz: number) =>
  buzz && listPrice > 0 && goldPerBuzz > 0
    ? Math.max(0, Math.floor(((buzz * goldPerBuzz - listPrice) * 100) / listPrice))
    : 0;

const TIER = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold' } as const;
export const tierName = (tier: string | null) =>
  tier && tier in TIER ? TIER[tier as keyof typeof TIER] : tier ?? '';

export const durationLabel = (days: number | null) =>
  days === null ? '' : days === 7 ? '1 week' : days === 1 ? '1 day' : `${days} days`;

const COSMETIC_TYPE = {
  Badge: 'Badge',
  NamePlate: 'Nameplate',
  ProfileDecoration: 'Avatar decoration',
  CardDecoration: 'Card decoration',
  Sticker: 'Sticker',
} as const;
export const cosmeticTypeLabel = (type: string | null) =>
  type && type in COSMETIC_TYPE
    ? COSMETIC_TYPE[type as keyof typeof COSMETIC_TYPE]
    : type ?? 'Cosmetic';

type CardLike = {
  kind: string;
  name: string;
  description: string;
  buzz: number | null;
  tier: string | null;
  days: number | null;
  cosmeticType: string | null;
  uses: number | null;
};

export const cardTitle = (card: CardLike) =>
  card.kind === 'buzz_pack'
    ? `Buzz pack · ${count(card.buzz ?? 0)}`
    : card.kind === 'membership'
    ? [`${tierName(card.tier)} membership`, durationLabel(card.days)].filter(Boolean).join(' · ')
    : card.name;

export const cardBlurb = (card: CardLike) =>
  card.description ||
  (card.kind === 'buzz_pack'
    ? `${count(card.buzz ?? 0)} Yellow Buzz, sent to your Civitai wallet.`
    : card.kind === 'membership'
    ? `${tierName(card.tier)} perks on Civitai${
        card.days === null ? '' : ` for ${durationLabel(card.days)}`
      }. Perks only, no monthly Buzz. Only if you have no active membership.`
    : card.cosmeticType === 'Sticker'
    ? `Sticker${card.uses ? ` · ${card.uses} uses` : ''}`
    : cosmeticTypeLabel(card.cosmeticType));

/** What a limited sticker's price buys: the price is for the whole pack, not per use. */
export const packNote = (card: Pick<CardLike, 'cosmeticType' | 'uses'>) =>
  card.cosmeticType === 'Sticker' && card.uses ? `${count(card.uses)} uses` : null;

export const cosmeticIcon = (
  kind: string | null,
  type: string | null
): 'zap' | 'crown' | 'sticker' | 'award' | 'id-card' | 'sparkles' =>
  kind === 'buzz_pack'
    ? 'zap'
    : kind === 'membership'
    ? 'crown'
    : type === 'Sticker'
    ? 'sticker'
    : type === 'Badge'
    ? 'award'
    : type === 'NamePlate'
    ? 'id-card'
    : 'sparkles';

export const PENDING_TEXT =
  'Your gold is reserved. Civitai has not confirmed it yet; we retry automatically and never charge twice.';

/** The main site's membership page, where each tier's perks are listed. */
export const membershipPerksUrl = (civitaiUrl: string) => `${civitaiUrl}/pricing`;

const COSMETIC_GROUPS = [
  { key: 'Badge', label: 'Badges', note: 'Yours forever' },
  { key: 'ProfileDecoration', label: 'Avatar frames', note: 'Worn around your avatar' },
  { key: 'Sticker', label: 'Stickers', note: '' },
  { key: 'NamePlate', label: 'Nameplates', note: 'Colors your name across Civitai' },
] as const;

export type CosmeticGroup<T> = { key: string; label: string; note: string; cards: T[] };

/** The shop's cosmetic shelves: one per known type in a fixed order, then anything else under Other; empty shelves are dropped. */
export function groupCosmetics<T extends { cosmeticType: string | null; uses: number | null }>(
  cards: T[]
): CosmeticGroup<T>[] {
  const known = new Set<string>(COSMETIC_GROUPS.map((group) => group.key));
  const groups: CosmeticGroup<T>[] = COSMETIC_GROUPS.map((group) => ({
    ...group,
    cards: cards.filter((card) => card.cosmeticType === group.key),
  }));
  groups.push({
    key: 'other',
    label: 'Other',
    note: '',
    cards: cards.filter((card) => !card.cosmeticType || !known.has(card.cosmeticType)),
  });
  return groups
    .filter((group) => group.cards.length > 0)
    .map((group) => (group.key === 'Sticker' ? { ...group, note: stickerNote(group.cards) } : group));
}

function stickerNote(cards: { uses: number | null }[]) {
  const uses = new Set(cards.map((card) => card.uses));
  const [only] = uses;
  return uses.size === 1 && only ? `${count(only)} uses each` : 'Buy again for more uses';
}

/** Offsets are authored in pixels at a 96px avatar and scaled to any avatar, as the main site does. */
const FRAME_BASE_PX = 96;

export function frameStyle(
  offsets: { top: number; left: number; right: number; bottom: number } | null
): { top: string; left: string; width: string; height: string } {
  if (!offsets) return { top: '0%', left: '0%', width: '100%', height: '100%' };
  const pct = (px: number) => `${((px / FRAME_BASE_PX) * 100).toFixed(3)}%`;
  return {
    top: pct(offsets.top),
    left: pct(offsets.left),
    width: `calc(100% - ${pct(offsets.left + offsets.right)})`,
    height: `calc(100% - ${pct(offsets.top + offsets.bottom)})`,
  };
}

export const nameplateBackground = (gradient: { from: string; to: string; deg: number }) =>
  `linear-gradient(${gradient.deg}deg, ${gradient.from}, ${gradient.to})`;
