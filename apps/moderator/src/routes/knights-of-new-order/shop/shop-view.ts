import { DEAL_PERCENT, MEMBERSHIP_DAYS, isSellable } from '@civitai/shared/knights-shop';
import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';

export type Kind = 'buzz_pack' | 'membership' | 'cosmetic';
export type StatusFilter = 'live' | 'retired' | 'all';
export type TodayEntry = { id: number; price: number; deal: boolean; hidden: boolean };
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

export const NOT_SOLD_REASON = 'The shop sells memberships one week at a time.';
export const HIDDEN_REASON = 'The cosmetic no longer exists, so players do not see this item.';
export const IN_REVIEW_REASON =
  'The cosmetic is still in review, so players cannot wear it and do not see this item.';
export const DEAL_LABEL = `-${DEAL_PERCENT}%`;

const PREVIEWABLE = new Set(['Badge', 'ProfileDecoration', 'ProfileBackground', 'Sticker']);

export const isKind = (value: string): value is Kind => value in KIND_GROUP;
export const humanize = (text: string) => text.replace(/([a-z])([A-Z])/g, '$1 $2');
export const titleCase = (text: string | null) =>
  text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
export const rankLabel = (minRank: string | null) => (minRank ? `${minRank}+` : 'Anyone');

export type Media = {
  url: string;
  type: 'image' | 'video' | 'audio' | undefined;
  /** A sticker says whether it moves; undefined leaves the CDN default. */
  animated: boolean | undefined;
};
export type Thumb = { cosmeticType: string | null; cosmeticData: unknown };

/** The image a cosmetic can show; null for a nameplate or frame, which the row names by type instead. */
export function cosmeticMedia(item: Thumb): Media | null {
  if (!item.cosmeticType || !PREVIEWABLE.has(item.cosmeticType)) return null;
  const data = item.cosmeticData as {
    url?: string | null;
    type?: Media['type'] | null;
    animated?: boolean | null;
  } | null;
  return data?.url
    ? { url: data.url, type: data.type ?? undefined, animated: data.animated ?? undefined }
    : null;
}

const COLOR = /^#[0-9a-f]{3,8}$/i;

/** A nameplate's gradient as CSS; null for another variant or anything that is not a plain hex pair. */
export function nameplateGradient(item: Thumb): string | null {
  if (item.cosmeticType !== 'NamePlate') return null;
  const data = item.cosmeticData as {
    variant?: string;
    gradient?: { from?: string; to?: string; deg?: number };
  } | null;
  const gradient = data?.gradient;
  if (data?.variant !== 'gradient' || !gradient?.from || !gradient.to) return null;
  if (!COLOR.test(gradient.from) || !COLOR.test(gradient.to)) return null;
  const deg =
    typeof gradient.deg === 'number' && Number.isFinite(gradient.deg) ? gradient.deg : 180;
  return `linear-gradient(${deg}deg, ${gradient.from}, ${gradient.to})`;
}

type Describable = {
  kind: string;
  name: string;
  price: number | null;
  buzz: number | null;
  tier: string | null;
  days: number | null;
  cosmeticId: number | null;
  cosmeticType: string | null;
};

/** What the item is, in a few words. */
export function whatItIs(item: Describable) {
  if (item.kind === 'buzz_pack') return `${(item.buzz ?? 0).toLocaleString()} Buzz`;
  if (item.kind === 'membership')
    return `${titleCase(item.tier)} · ${
      item.days === MEMBERSHIP_DAYS ? '1 week' : `${item.days} days`
    }`;
  return item.cosmeticType ? humanize(item.cosmeticType) : `Cosmetic #${item.cosmeticId}`;
}

export const buzzRate = (price: number, buzz: number) =>
  `${Number((price / buzz).toFixed(1)).toLocaleString()} gold / Buzz`;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The line under an item's name: what it is, unless the name already says so; a Buzz pack adds its rate. */
export function secondaryLine(item: Describable): string | null {
  const what = whatItIs(item);
  if (item.kind === 'buzz_pack') {
    const rate = item.buzz && item.price ? buzzRate(item.price, item.buzz) : null;
    return same(item.name, what) ? rate : [what, rate].filter(Boolean).join(' · ');
  }
  return same(item.name, what) ? null : what;
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
  if (item.kind === 'cosmetic' && item.cosmeticWithheld)
    return {
      kind: 'hidden',
      label: 'Hidden: cosmetic in review',
      tip: IN_REVIEW_REASON,
      deal: null,
    };
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

/** What restoring does to a retired item that the shop still would not show, or null when it simply goes on sale. */
export function restoreNote(item: Pick<ShopItemRow, 'kind' | 'days' | 'cosmeticType'>) {
  if (!isSellable(item))
    return `It stays off sale: ${NOT_SOLD_REASON.charAt(0).toLowerCase()}${NOT_SOLD_REASON.slice(
      1
    )}`;
  if (item.kind === 'cosmetic' && item.cosmeticType === null)
    return 'It stays hidden from players: its cosmetic no longer exists.';
  return null;
}
