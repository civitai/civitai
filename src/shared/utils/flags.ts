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
}
