import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';

/**
 * A golden file of values captured from a Prisma read, keyed by case name. JSON cannot carry a Date
 * or a Decimal, so the capture tagged them: `{ "$date": "<ISO>" }` reads back as a Date and
 * `{ "$decimal": "<text>" }` as a `Prisma.Decimal`, so `toStrictEqual` still checks the type a
 * consumer receives.
 *
 * `take(name)` returns one case and records it; `unused()` lists the cases no test took, so a suite
 * can fail when a captured case stops being asserted.
 */
export function readTaggedGolden(path: string) {
  const cases = JSON.parse(readFileSync(path, 'utf8'), (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === '$date') return new Date(value.$date);
      if (keys.length === 1 && keys[0] === '$decimal') return new Prisma.Decimal(value.$decimal);
    }
    return value;
  }) as Record<string, unknown>;
  const taken = new Set<string>();
  return {
    take<T = unknown>(name: string): T {
      if (!(name in cases)) throw new Error(`golden: no case named "${name}"`);
      taken.add(name);
      return cases[name] as T;
    },
    unused: () => Object.keys(cases).filter((name) => !taken.has(name)),
  };
}
