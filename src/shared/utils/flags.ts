export abstract class Flags {
  private static possibleValues: number[] = (() =>
    [...new Array(32)].map((_, i) => Math.pow(2, i)))();

  /**
   * Determines whether one or more bit fields are set in the current instance.
   * @param instance - combined bit values
   * @param flag - An enumeration value
   * @returns true if the bit field or bit fields that are set in flag are also set in the current instance; otherwise, false.
   */
  static hasFlag(instance: number, flag: number) {
    return (instance | flag) === instance;
  }

  /** given two bitwise instances, returns a bitwise value representing the shared bits between the two instances */
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

  /**
   * converts an enum object to an array of number values
   * ```
   * enum Roles {
   *   user = 1,
   *   manager = 2
   *   admin = 4
   * }
   * becomes [1, 2, 4]
   * ```
   */
  static enumToBitArray(enumValue: object) {
    return Object.keys(enumValue).map(Number).filter(Boolean);
  }

  /**
   * converts an instance to an array of numbers
   *  ```
   * 11 => [1, 2, 8]
   * ```
   */
  static instanceToArray(instance: number) {
    return this.possibleValues.filter((x) => this.hasFlag(instance, x));
  }

  /**
   * convert an array of number values to an instance
   * ```
   * [1, 2, 4] => 7
   * ```
   * */
  static arrayToInstance(flagsArray: number[]) {
    return flagsArray.reduce((agg, cur) => {
      const toAdd = this.possibleValues.includes(cur) ? cur : 0;
      return agg + toAdd;
    }, 0);
  }

  /** returns the bitwise difference between two bitwise values */
  static diff(a: number, b: number) {
    return a & ~b;
  }

  /** returns the number of bit positions between two flag values */
  static distance(a: number, b: number): number {
    const pos1 = Math.log2(a);
    const pos2 = Math.log2(b);

    return Math.abs(pos1 - pos2);
  }

  static increaseByBits(instance: number, bits = 1) {
    return instance << bits;
  }
}

/**
 * Creates a typed bitmask wrapper class for a given flags enum.
 * Provides easy get/set access to individual flags and automatic conversion to number for Prisma.
 *
 * @example
 * // Define your flags enum
 * enum MyFlags { flagA = 1, flagB = 2, flagC = 4 }
 *
 * // Create a wrapper instance
 * const flags = new FlagsBitmask<typeof MyFlags>(MyFlags, 3); // flagA | flagB
 * flags.has(MyFlags.flagA); // true
 * flags.set(MyFlags.flagC);
 * flags.value; // 7
 */
export class FlagsBitmask<T extends object> {
  private _value: number;

  constructor(value: number = 0) {
    this._value = value;
  }

  /** Get the raw numeric value of the flags */
  get value(): number {
    return this._value;
  }

  /** Set the raw numeric value of the flags */
  set value(v: number) {
    this._value = v;
  }

  /** Returns the numeric value - allows automatic conversion in numeric contexts */
  valueOf(): number {
    return this._value;
  }

  /** Returns string representation for debugging */
  toString(): string {
    return this._value.toString();
  }

  /** Returns the numeric value for JSON serialization */
  toJSON(): number {
    return this._value;
  }

  /** Check if a specific flag is set */
  has(flag: number): boolean {
    return (this._value & flag) !== 0;
  }

  /** Set a specific flag */
  set(flag: number, value: boolean = true): this {
    this._value = value ? this._value | flag : this._value & ~flag;
    return this;
  }

  /** Unset a specific flag */
  unset(flag: number): this {
    this._value = this._value & ~flag;
    return this;
  }

  /** Toggle a specific flag */
  toggle(flag: number): this {
    this._value = this._value ^ flag;
    return this;
  }
}

// Type for Prisma client that supports $executeRawUnsafe
type DbClientWithRaw = {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number>;
};

/**
 * Creates a fluent builder for atomic flag updates on any table.
 * Uses SQL bitwise operations for race-condition-free updates.
 *
 * @example
 * // Single flag
 * await flagUpdate(dbWrite, 'Image', imageId)
 *   .set(ImageFlags.nsfwLevelLocked)
 *   .execute();
 *
 * @example
 * // Multiple flags combined with |
 * await flagUpdate(dbWrite, 'Image', imageId)
 *   .set(ImageFlags.nsfwLevelLocked | ImageFlags.poi)
 *   .unset(ImageFlags.hideMeta | ImageFlags.minor)
 *   .execute();
 *
 * @example
 * // Bulk update multiple records
 * await flagUpdate(dbWrite, 'Image', [id1, id2, id3])
 *   .set(ImageFlags.poi)
 *   .execute();
 */
export function flagUpdate(
  db: DbClientWithRaw,
  table: 'Image' | 'Model' | 'ModelVersion',
  id: number | number[]
) {
  let setMask = 0;
  let unsetMask = 0;
  let toggleMask = 0;

  const builder = {
    /**
     * Set one or more flags (turn bits ON)
     * @param flags - Single flag or multiple flags combined with |
     */
    set(flags: number) {
      setMask |= flags;
      return builder;
    },

    /**
     * Unset one or more flags (turn bits OFF)
     * @param flags - Single flag or multiple flags combined with |
     */
    unset(flags: number) {
      unsetMask |= flags;
      return builder;
    },

    /**
     * Set a flag to a specific boolean value
     * @param flags - Single flag or multiple flags combined with |
     * @param value - true to set, false to unset
     */
    setTo(flags: number, value: boolean) {
      if (value) {
        setMask |= flags;
      } else {
        unsetMask |= flags;
      }
      return builder;
    },

    /**
     * Toggle one or more flags (flip bits using XOR)
     * @param flags - Single flag or multiple flags combined with |
     */
    toggle(flags: number) {
      toggleMask |= flags;
      return builder;
    },

    /**
     * Execute the atomic update
     * @returns Number of rows affected
     */
    async execute(): Promise<number> {
      if (setMask === 0 && unsetMask === 0 && toggleMask === 0) return 0;

      const ids = Array.isArray(id) ? id : [id];
      if (ids.length === 0) return 0;

      // Build the SQL based on what operations are needed
      // Formula: ((flags | setMask) & ~unsetMask) ^ toggleMask
      let flagsExpr = 'flags';
      if (setMask !== 0) {
        flagsExpr = `(${flagsExpr} | ${setMask})`;
      }
      if (unsetMask !== 0) {
        flagsExpr = `(${flagsExpr} & ~${unsetMask})`;
      }
      if (toggleMask !== 0) {
        flagsExpr = `(${flagsExpr} # ${toggleMask})`; // # is XOR in PostgreSQL
      }

      const result = await db.$executeRawUnsafe(
        `UPDATE "${table}" SET flags = ${flagsExpr}, "updatedAt" = NOW() WHERE id = ANY($1)`,
        ids
      );

      return result;
    },
  };

  return builder;
}
