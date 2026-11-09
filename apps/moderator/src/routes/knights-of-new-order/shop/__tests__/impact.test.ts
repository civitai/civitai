import { describe, expect, it } from 'vitest';
import { stockFor, type ShopItem } from '@civitai/shared/knights-shop';
import { impactOfAdd, impactOfChange } from '../impact';

const DAY = '2026-12-20';
const item = (id: number, o: Partial<ShopItem> = {}): ShopItem => ({
  id,
  kind: 'buzz_pack',
  name: `item-${id}`,
  description: '',
  price: 1000,
  buzz: 50,
  cosmeticId: null,
  tier: null,
  days: null,
  minRank: null,
  active: true,
  rotating: false,
  sortOrder: id,
  ...o,
});
const catalog = [
  ...Array.from({ length: 8 }, (_, i) => item(i + 1, { rotating: true })),
  item(20),
  item(21),
];
const stock = stockFor(catalog, DAY).stock;
const inToday = stock.find((e) => e.item.rotating)!.item;
const outToday = catalog.find((c) => c.rotating && !stock.some((e) => e.item.id === c.id))!;

describe('impactOfChange', () => {
  it("warns about in-flight purchases when the price of an item in today's stock changes", () => {
    expect(impactOfChange(catalog, DAY, inToday.id, { price: inToday.price + 1 })).toEqual([
      "This item is in today's shop: a new price refuses purchases already in flight.",
    ]);
  });

  it("is silent for a price change on an item that is not in today's stock", () => {
    expect(impactOfChange(catalog, DAY, outToday.id, { price: 5 })).toEqual([]);
  });

  it('is silent when nothing moves', () => {
    expect(impactOfChange(catalog, DAY, inToday.id, { price: inToday.price })).toEqual([]);
  });

  it("names the item that drops out when one in today's stock is retired", () => {
    const [message] = impactOfChange(catalog, DAY, inToday.id, { active: false });
    expect(message).toContain(`${inToday.name} drops out`);
  });

  it("says nothing about retiring an item that is not in today's stock", () => {
    expect(impactOfChange(catalog, DAY, outToday.id, { active: false })).toEqual([]);
  });

  it('reports the redraw when a rotating item is turned off', () => {
    const messages = impactOfChange(catalog, DAY, inToday.id, { rotating: false });
    expect(messages.join(' ')).toMatch(/Today's shop changes/);
  });
});

describe('impactOfAdd', () => {
  it('says what a rotating and a fixed item can do', () => {
    expect(impactOfAdd(true)[0]).toMatch(/redraw today's rotation/);
    expect(impactOfAdd(false)[0]).toMatch(/move today's deals/);
  });
});

describe('impactOfChange with a hidden cosmetic', () => {
  const ghost = {
    ...item(30, { kind: 'cosmetic', buzz: null, cosmeticId: 9 }),
    cosmeticType: null,
  };
  const items = [ghost, item(31)];

  it('does not announce an item players never see as dropping out or coming in', () => {
    expect(impactOfChange(items, DAY, ghost.id, { active: false })).toEqual([]);
    expect(
      impactOfChange([{ ...ghost, active: false }, item(31)], DAY, ghost.id, { active: true })
    ).toEqual([]);
  });

  it('draws an item still in review into no slot, so it never displaces a visible one', () => {
    const pending = { ...item(32, { rotating: true }), cosmeticWithheld: true };
    const rotating = [31, 33, 34, 35, 36].map((id) => item(id, { rotating: true }));
    const stock = (rows: typeof rotating) => impactOfChange(rows, DAY, 31, { rotating: false });
    expect(stock([...rotating, pending])).toEqual(stock(rotating));
  });

  it('still announces a visible item dropping out when it is retired', () => {
    expect(impactOfChange(items, DAY, 31, { active: false }).join(' ')).toContain(
      'item-31 drops out'
    );
  });
});
