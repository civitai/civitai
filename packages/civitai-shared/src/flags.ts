// Pure bitwise-flag helpers, no deps — client-safe. Mirror of the main app's `~/shared/utils/flags`, moved
// here so cross-app modules (e.g. browsing-levels) can share one implementation.
export abstract class Flags {
  private static possibleValues: number[] = (() =>
    [...new Array(32)].map((_, i) => Math.pow(2, i)))();

  /** true if every bit set in `flag` is also set in `instance`. */
  static hasFlag(instance: number, flag: number) {
    return (instance | flag) === instance;
  }

  /** the bits shared between two instances. */
  static intersection(instance1: number, instance2: number) {
    return instance1 & instance2;
  }

  static intersects(instance1: number, instance2: number) {
    return (instance1 & instance2) !== 0;
  }

  static addFlag(instance: number, flag: number) {
    return instance | flag;
  }

  static removeFlag(instance: number, flag: number) {
    return instance & ~flag;
  }

  static maxValue(flag: number) {
    return Math.max(...this.instanceToArray(flag));
  }

  static toggleFlag(instance: number, flag: number) {
    return this.hasFlag(instance, flag)
      ? this.removeFlag(instance, flag)
      : this.addFlag(instance, flag);
  }

  /** enum object → array of its numeric values, e.g. `{ user: 1, admin: 4 }` → `[1, 4]`. */
  static enumToBitArray(enumValue: object) {
    return Object.keys(enumValue).map(Number).filter(Boolean);
  }

  /** instance → array of the set bits, e.g. `11` → `[1, 2, 8]`. */
  static instanceToArray(instance: number) {
    return this.possibleValues.filter((x) => this.hasFlag(instance, x));
  }

  /** array of bit values → instance, e.g. `[1, 2, 4]` → `7`. */
  static arrayToInstance(flagsArray: number[]) {
    return flagsArray.reduce((agg, cur) => {
      const toAdd = this.possibleValues.includes(cur) ? cur : 0;
      return agg + toAdd;
    }, 0);
  }

  /** the bitwise difference between two values. */
  static diff(a: number, b: number) {
    return a & ~b;
  }

  /** the number of bit positions between two single-bit flag values. */
  static distance(a: number, b: number): number {
    const pos1 = Math.log2(a);
    const pos2 = Math.log2(b);

    return Math.abs(pos1 - pos2);
  }

  static increaseByBits(instance: number, bits = 1) {
    return instance << bits;
  }
}
