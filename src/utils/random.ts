const max = 10e17;
/**
 * seed based random numbers
 * adapted from https://stackoverflow.com/a/424445/5149338
 */
export class Random {
  // LCG using GCC's constants
  m = 0x80000000; // 2**31;
  a = 1103515245;
  c = 12345;

  seed: number;

  constructor(seed = Date.now()) {
    this.seed = seed;
  }

  private nextInt() {
    this.seed = (this.a * this.seed + this.c) % this.m;
    return this.seed;
  }

  // private nextFloat() {
  //   return this.nextInt() / (this.m - 1);
  // }

  // nextRange(start: number, end: number) {
  //   // returns in range [start, end): including start, excluding end
  //   // can't modulu nextInt because of weak randomness in lower bits
  //   const rangeSize = end - start;
  //   const randomUnder1 = this.nextInt() / this.m;
  //   return start + Math.floor(randomUnder1 * rangeSize);
  // }

  number() {
    const randomUnder1 = this.nextInt() / this.m;
    return Math.floor(randomUnder1 * max) / max;
  }

  fromArray<T>(array: T[]) {
    return array[Math.floor(this.number() * array.length)];
  }
}
