// Shared NSFW level utilities and Flags class for feed services

// NSFW Level constants
export const NsfwLevel = {
  PG: 1,
  PG13: 2,
  R: 4,
  X: 8,
  XXX: 16,
  Blocked: 32,
} as const;

export type NsfwLevelType = typeof NsfwLevel[keyof typeof NsfwLevel];

// NSFW browsing levels array for filtering
export const nsfwBrowsingLevelsArray = [
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
  NsfwLevel.Blocked,
];

// Combined flag value for NSFW browsing levels
export const nsfwBrowsingLevelsFlag = nsfwBrowsingLevelsArray.reduce(
  (acc, level) => acc | level,
  0
);

/**
 * Flags utility class for bitwise operations
 * Used for handling browsing level flags and other bitwise values
 */
export class Flags {
  private static possibleValues: number[] = (() =>
    [...new Array(32)].map((_, i) => Math.pow(2, i)))();

  /**
   * Converts a bitwise instance to an array of flag values
   * Example: 11 => [1, 2, 8]
   */
  static instanceToArray(instance: number): number[] {
    const result: number[] = [];
    let bit = 1;
    while (bit <= instance) {
      if (instance & bit) result.push(bit);
      bit <<= 1;
    }
    return result;
  }

  /**
   * Determines whether one or more bit fields are set in the current instance
   * @param instance - combined bit values
   * @param flag - An enumeration value
   * @returns true if the bit field or bit fields that are set in flag are also set in the current instance; otherwise, false.
   */
  static hasFlag(instance: number, flag: number): boolean {
    return (instance | flag) === instance;
  }

  /**
   * Checks if two bitwise instances have any common bits set
   */
  static intersects(a: number, b: number): boolean {
    return (a & b) !== 0;
  }

  /**
   * Returns the bitwise intersection of two instances
   */
  static intersection(instance1: number, instance2: number): number {
    return instance1 & instance2;
  }

  /**
   * Adds a flag to an instance
   */
  static addFlag(instance: number, flag: number): number {
    return instance | flag;
  }

  /**
   * Removes a flag from an instance
   */
  static removeFlag(instance: number, flag: number): number {
    return instance & ~flag;
  }

  /**
   * Toggles a flag in an instance
   */
  static toggleFlag(instance: number, flag: number): number {
    return this.hasFlag(instance, flag)
      ? this.removeFlag(instance, flag)
      : this.addFlag(instance, flag);
  }

  /**
   * Returns the maximum value in a flag instance
   */
  static maxValue(flag: number): number {
    return Math.max(...this.instanceToArray(flag));
  }

  /**
   * Converts an enum object to an array of number values
   * Example: enum Roles { user = 1, manager = 2, admin = 4 } becomes [1, 2, 4]
   */
  static enumToBitArray(enumValue: object): number[] {
    return Object.keys(enumValue).map(Number).filter(Boolean);
  }

  /**
   * Converts an array of number values to an instance
   * Example: [1, 2, 4] => 7
   */
  static arrayToInstance(flagsArray: number[]): number {
    return flagsArray.reduce((agg, cur) => {
      const toAdd = this.possibleValues.includes(cur) ? cur : 0;
      return agg + toAdd;
    }, 0);
  }

  /**
   * Returns the bitwise difference between two bitwise values
   */
  static diff(a: number, b: number): number {
    return a & ~b;
  }

  /**
   * Returns the number of bit positions between two flag values
   */
  static distance(a: number, b: number): number {
    const pos1 = Math.log2(a);
    const pos2 = Math.log2(b);
    return Math.abs(pos1 - pos2);
  }

  /**
   * Increases a flag instance by a number of bit positions
   */
  static increaseByBits(instance: number, bits = 1): number {
    return instance << bits;
  }
}

/**
 * Removes the Blocked level from a browsing level
 * Used to filter out blocked content from user-selectable levels
 */
export function onlySelectableLevels(level: number): number {
  if (level & NsfwLevel.Blocked) level = level & ~NsfwLevel.Blocked;
  return level;
}

/**
 * Snaps a timestamp to a regular interval for caching consistency
 * @param unixTimestamp - The timestamp to snap
 * @param intervalMillisec - The interval in milliseconds (default: 60000 = 1 minute)
 * @returns The snapped timestamp
 */
export function snapToInterval(unixTimestamp: number, intervalMillisec = 60000): number {
  return Math.floor(unixTimestamp / intervalMillisec) * intervalMillisec;
}
