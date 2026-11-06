import { DEAL_PERCENT, isSellable } from '@civitai/shared/knights-shop';
import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';

export type Kind = 'buzz_pack' | 'membership' | 'cosmetic';
export type StatusFilter = 'live' | 'retired' | 'all';
export type TodayEntry = { id: number; price: number; deal: boolean };
export type Today = ReadonlyMap<number, TodayEntry>;

/** The order the Knights shop lays its sections out in. */
export const KIND_ORDER: readonly Kind[] = ['buzz_pack', 'membership', 'cosmetic'];
export const KIND_GROUP: Record<Kind, string> = {
  buzz_pack: 'Buzz packs',
  membership: 'Memberships',
  cosmetic: 'Cosmetics',
};
export const KIND_ONE: Record<Kind, string> = {
  buzz_pack: 'Buzz pack',
  membership: 'Membership',
  cosmetic: 'Cosmetic',
};

export const NOT_SOLD_REASON = 'The shop sells memberships one month at a time.';
export const HIDDEN_REASON = 'The cosmetic no longer exists, so players do not see this item.';
export const DEAL_LABEL = `-${DEAL_PERCENT}%`;

const PREVIEWABLE = new Set(['Badge', 'ProfileDecoration', 'ProfileBackground']);

export const isKind = (value: string): value is Kind => value in KIND_GROUP;
export const humanize = (text: string) => text.replace(/([a-z])([A-Z])/g, '$1 $2');
export const titleCase = (text: string | null) =>
  text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
export const rankLabel = (minRank: string | null) => (minRank ? `${minRank}+` : 'Anyone');

export type Media = { url: string; type: 'image' | 'video' | 'audio' | undefined };
export type Thumb = { cosmeticType: string | null; cosmeticData: unknown };

/** The image a cosmetic can show; null for a nameplate or frame, which the row names by type instead. */
export function cosmeticMedia(item: Thumb): Media | null {
  if (!item.cosmeticType || !PREVIEWABLE.has(item.cosmeticType)) return null;
  const data = item.cosmeticData as { url?: string | null; type?: Media['type'] | null } | null;
  return data?.url ? { url: data.url, type: data.type ?? undefined } : null;
}

type Describable = Pick<
  ShopItemRow,
  'kind' | 'buzz' | 'tier' | 'months' | 'cosmeticId' | 'cosmeticName' | 'cosmeticType'
>;

/** What the item is, in a few words: the second line under its name. */
export function whatItIs(item: Describable) {
  if (item.kind === 'buzz_pack') return `${(item.buzz ?? 0).toLocaleString()} Buzz`;
  if (item.kind === 'membership')
    return `${titleCase(item.tier)} · ${item.months === 1 ? '1 month' : `${item.months} months`}`;
  return item.cosmeticType ? humanize(item.cosmeticType) : `Cosmetic #${item.cosmeticId}`;
}

export type AvailabilityKind =
  | 'retired'
  | 'not-sold'
  | 'hidden'
  | 'always'
  | 'in-today'
  | 'not-today';
export type Availability = {
  kind: AvailabilityKind;
  label: string;
  tip: string | null;
  /** Today's deal price, when the item is a deal today and players can see it. */
  deal: number | null;
};

export function availability(item: ShopItemRow, today: Today): Availability {
  if (!item.active) return { kind: 'retired', label: 'Retired', tip: null, deal: null };
  if (!isSellable(item))
    return { kind: 'not-sold', label: 'Not sold', tip: NOT_SOLD_REASON, deal: null };
  if (item.kind === 'cosmetic' && item.cosmeticType === null)
    return { kind: 'hidden', label: 'Hidden: cosmetic missing', tip: HIDDEN_REASON, deal: null };
  const entry = today.get(item.id);
  const deal = entry?.deal ? entry.price : null;
  if (!item.rotating) return { kind: 'always', label: 'Always on sale', tip: null, deal };
  return entry
    ? { kind: 'in-today', label: 'Rotating · in today', tip: null, deal }
    : { kind: 'not-today', label: 'Rotating · not today', tip: null, deal };
}

export const todayOf = (entries: readonly TodayEntry[]): Today =>
  new Map(entries.map((entry) => [entry.id, entry]));

export type Query = { q: string; status: StatusFilter; kind: Kind | '' };

export function matchesQuery(item: ShopItemRow, q: string) {
  const needle = q.trim().toLowerCase().replace(/^#/, '');
  if (!needle) return true;
  return (
    item.name.toLowerCase().includes(needle) ||
    String(item.id) === needle ||
    (item.cosmeticName?.toLowerCase().includes(needle) ?? false)
  );
}

export const matchesStatus = (item: ShopItemRow, status: StatusFilter) =>
  status === 'all' || item.active === (status === 'live');

export const filterItems = (items: readonly ShopItemRow[], query: Query) =>
  items.filter(
    (item) =>
      matchesStatus(item, query.status) &&
      (query.kind === '' || item.kind === query.kind) &&
      matchesQuery(item, query.q)
  );

export const statusCounts = (items: readonly ShopItemRow[]) => {
  const live = items.filter((item) => item.active).length;
  return { live, retired: items.length - live, all: items.length };
};

export const groupByKind = (items: readonly ShopItemRow[]) =>
  KIND_ORDER.map((kind) => ({ kind, items: items.filter((item) => item.kind === kind) })).filter(
    (group) => group.items.length > 0
  );

/** "3h 12m" until the last hour, then "12m 05s". */
export function countdown(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** What one shop card shows; built from a catalog row or from a half-typed form. */
export type CardModel = {
  kind: Kind;
  name: string;
  price: number | null;
  /** Struck-through list price, set when the card is a deal. */
  listPrice: number | null;
  minRank: string | null;
  buzz: number | null;
  tier: string | null;
  cosmeticType: string | null;
  cosmeticData: unknown;
  hidden: string | null;
};

export const cardFor = (
  item: ShopItemRow,
  entry: { price: number; deal: boolean } | null,
  hidden: string | null = null
): CardModel => ({
  kind: item.kind as Kind,
  name: item.name,
  price: entry?.price ?? item.price,
  listPrice: entry?.deal ? item.price : null,
  minRank: item.minRank,
  buzz: item.buzz,
  tier: item.tier,
  cosmeticType: item.cosmeticType,
  cosmeticData: item.cosmeticData,
  hidden,
});

export type SheetTarget =
  | { mode: 'create' }
  | { mode: 'edit'; id: number; tab: 'details' | 'history' };

export type StatusTarget = { item: ShopItemRow; action: 'retire' | 'restore' };

const dayName = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const dayShort = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const dayLong = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const at = (day: string) => new Date(`${day}T00:00:00Z`);
export const addDays = (day: string, days: number) =>
  new Date(at(day).getTime() + days * 86_400_000).toISOString().slice(0, 10);
export const longDay = (day: string) => dayLong.format(at(day));

/** Today, tomorrow, then the next days as weekday and date; a day past that (typed in) is appended. */
export function previewDays(today: string, selected: string, ahead = 5) {
  const days = [
    { value: today, label: 'Today' },
    { value: addDays(today, 1), label: 'Tomorrow' },
    ...Array.from({ length: ahead }, (_, i) => {
      const value = addDays(today, i + 2);
      return { value, label: `${dayName.format(at(value))} ${dayShort.format(at(value))}` };
    }),
  ];
  return days.some((d) => d.value === selected)
    ? days
    : [...days, { value: selected, label: dayShort.format(at(selected)) }];
}
