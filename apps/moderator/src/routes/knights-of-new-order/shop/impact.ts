import { isSellable, stockFor, type ShopItem } from '@civitai/shared/knights-shop';

type Row = ShopItem & { cosmeticType?: string | null; cosmeticWithheld?: boolean };
type Patch = Partial<Pick<ShopItem, 'price' | 'rotating' | 'active'>>;

const list = (names: string[]) =>
  names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;

// An item still in review is not drawn at all, as in the shop.
const todaysStock = (items: Row[], day: string) =>
  stockFor(
    items.filter((item) => isSellable(item) && !(item as Row).cosmeticWithheld),
    day
  ).stock;

/** Drawn for the day but never shown: its cosmetic is gone. */
const hidden = (item: ShopItem) => item.kind === 'cosmetic' && (item as Row).cosmeticType === null;

type Stock = ReturnType<typeof todaysStock>;
const shown = (stock: Stock) => stock.filter((entry) => !hidden(entry.item));

/**
 * What saving `patch` onto one item does to the shop right now, by drawing today's stock before and after
 * with the same `stockFor` the shop runs. Empty when the change does not reach a player.
 */
export function impactOfChange(items: Row[], day: string, id: number, patch: Patch): string[] {
  const before = shown(todaysStock(items, day));
  const after = shown(
    todaysStock(
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      day
    )
  );
  const messages: string[] = [];
  const was = before.find((entry) => entry.item.id === id);
  if (was && patch.price !== undefined && patch.price !== was.item.price && patch.active !== false)
    messages.push("This item is in today's shop: a new price refuses purchases already in flight.");

  const beforeIds = new Set(before.map((entry) => entry.item.id));
  const afterIds = new Set(after.map((entry) => entry.item.id));
  const comesIn = after.filter((entry) => !beforeIds.has(entry.item.id));
  const dropsOut = before.filter((entry) => !afterIds.has(entry.item.id));
  const dealIds = (stock: Stock) =>
    stock
      .filter((entry) => entry.deal)
      .map((entry) => entry.item.id)
      .sort((a, b) => a - b)
      .join();
  const dealsMove = dealIds(before) !== dealIds(after);

  const shifts: string[] = [];
  if (dropsOut.length) shifts.push(`${list(dropsOut.map((e) => e.item.name))} drops out`);
  if (comesIn.length) shifts.push(`${list(comesIn.map((e) => e.item.name))} comes in`);
  if (dealsMove)
    shifts.push(
      `today's deals become ${list(after.filter((e) => e.deal).map((e) => e.item.name)) || 'none'}`
    );
  if (shifts.length)
    messages.push(
      `Today's shop changes: ${shifts.join(
        ', '
      )}. Purchases already in flight for what moved are refused.`
    );
  return messages;
}

/** A new item has no id yet, so its draw cannot be simulated: say what it can do. */
export function impactOfAdd(rotating: boolean): string[] {
  return [
    rotating
      ? "Adding a rotating item can redraw today's rotation and move today's deals."
      : "A new item on sale all day joins today's shop and can move today's deals.",
  ];
}
