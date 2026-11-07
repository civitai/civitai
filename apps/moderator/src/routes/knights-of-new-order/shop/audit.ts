import type { FieldChange } from '$lib/server/knights/shop-catalog.schema';

export type AuditRow = {
  id: number;
  itemId: number;
  itemName: string;
  action: string;
  changes: Record<string, FieldChange>;
  createdAt: Date | string;
  moderatorId: number | null;
  moderatorUsername: string | null;
  cosmeticName?: string | null;
  cosmeticType?: string | null;
};

export type Chip = { field: string; from: string | null; to: string };
export type Described = { verb: string; chips: Chip[] };

const SINGLE_FIELD_VERB: Record<string, string> = {
  name: 'renamed',
  description: 'edited the description of',
  price: 'changed the price of',
  minRank: 'changed the rank gate of',
  rotating: 'changed the rotation of',
  sortOrder: 'moved',
};
const FIELD_LABEL: Record<string, string> = {
  minRank: 'rank',
  sortOrder: 'sort',
  cosmeticId: 'cosmetic',
};
const MAX_TEXT = 36;

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'boolean')
    return field === 'active' ? (value ? 'live' : 'retired') : value ? 'on' : 'off';
  const text = String(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

const label = (field: string) => FIELD_LABEL[field] ?? field;

/** On create every column is "set from null"; only the ones that say something about the item are worth a chip. */
function createChips(
  changes: Record<string, FieldChange>,
  cosmetic: { name: string | null; type: string | null }
): Chip[] {
  const chips: Chip[] = [];
  const set = (field: string, to: unknown) =>
    chips.push({ field: label(field), from: null, to: show(field, to) });
  for (const [field, { to }] of Object.entries(changes)) {
    if (['kind', 'name', 'active', 'days'].includes(field)) continue;
    if (to === null || to === undefined || to === '' || to === false) continue;
    if (field === 'sortOrder' && to === 0) continue;
    if (field === 'rotating') chips.push({ field: 'rotating', from: null, to: 'on' });
    else if (field === 'cosmeticId')
      chips.push({
        field: 'cosmetic',
        from: null,
        to: cosmetic.name
          ? `${cosmetic.name}${cosmetic.type ? ` (${cosmetic.type})` : ''}`
          : `#${String(to)}`,
      });
    else set(field, to);
  }
  return chips;
}

export function describeChange(change: {
  action: string;
  changes: Record<string, FieldChange>;
  cosmeticName?: string | null;
  cosmeticType?: string | null;
}): Described {
  switch (change.action) {
    case 'create':
      return {
        verb: 'added',
        chips: createChips(change.changes, {
          name: change.cosmeticName ?? null,
          type: change.cosmeticType ?? null,
        }),
      };
    case 'retire':
      return { verb: 'retired', chips: [] };
    case 'restore':
      return { verb: 'restored', chips: [] };
  }
  const entries = Object.entries(change.changes);
  const chips = entries.map(([field, { from, to }]) => ({
    field: label(field),
    from: show(field, from),
    to: show(field, to),
  }));
  const verb = (entries.length === 1 && SINGLE_FIELD_VERB[entries[0][0]]) || 'updated';
  return { verb, chips };
}

/** `2026-11-05` for grouping a timeline by UTC day. */
export const utcDayOf = (value: Date | string) => new Date(value).toISOString().slice(0, 10);

export function groupByDay<T extends { createdAt: Date | string }>(rows: readonly T[]) {
  const groups: { day: string; rows: T[] }[] = [];
  for (const row of rows) {
    const day = utcDayOf(row.createdAt);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}
