export type SpendCurrency = 'yellow' | 'green';

/** The accounts a submit charges, in order: Blue ahead of the paid account unless the user turned
 *  Blue-first off, then the paid account only. */
export function spendOrder(mode: SpendCurrency, blueFirst: boolean): string[] {
  return blueFirst ? ['blue', mode] : [mode];
}

export type Spend = {
  amount: number;
  currency: SpendCurrency;
  uncertain: boolean;
};

/** How much of `price` comes out of a non-Blue account, Blue spending first. Null = nothing beyond Blue.
 *  Blue pays for training whatever the dataset, member or not; a mature dataset's non-Blue part is Yellow,
 *  never Green. `blue` undefined = the balance couldn't be read, so assume the whole price may be non-Blue
 *  (fail safe). The one definition for every quote, note and gate. */
export function matureSpend(args: {
  price: number | null | undefined;
  blue: number | undefined;
  mode: SpendCurrency;
  mature: boolean;
}): Spend | null {
  const { price, blue, mode, mature } = args;
  if (price == null || price <= 0) return null;
  const currency: SpendCurrency = mature ? 'yellow' : mode;
  if (typeof blue !== 'number') return { amount: price, currency, uncertain: true };
  if (price <= blue) return null;
  return { amount: price - Math.max(0, blue), currency, uncertain: false };
}

/** The server rated a dataset mature that the client priced as not mature, on a charge that would spend
 *  Green: nothing was charged, and the client reprices it (Yellow, not Green) before the user starts again. */
export class MatureRepriceError extends Error {
  readonly matureCount: number;
  constructor(matureCount: number) {
    super(
      `This dataset has ${matureCount} mature image${
        matureCount === 1 ? '' : 's'
      }, which Green Buzz can't pay for, so anything beyond your Blue Buzz is charged in Yellow. Nothing was charged; check the price and start again.`
    );
    this.matureCount = matureCount;
  }
}
