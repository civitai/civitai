import type { PrismaClient } from '@prisma/client';
import { expect } from 'vitest';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';

/**
 * One seeded row: `include` says whether the eligibility rule must keep it. Every clause of the
 * rule needs a row that only that clause excludes, or a side that dropped the clause would still
 * pass.
 */
export type ParityRow = { id: number; name: string; include: boolean; insert: string };

export type ParitySpec = {
  /** Types, tables and columns both sides read (see the pglite-prisma harness). */
  schema: string;
  rows: ParityRow[];
  /** The clause names of the rule; each must have an excluded row whose name it is. */
  clauses: string[];
  /** The site's rule, run through the Prisma client. */
  site: (prisma: PrismaClient) => Promise<number[]>;
  /** The copy of the rule outside the site (the event-engine's SQL): selects `id`. */
  copy: string;
};

export type ParitySide = { missing: string[]; extra: string[] };

/**
 * Seeds the rows into one PGlite database, runs the site's Prisma rule and the copied SQL against
 * it, and reports, per side, the rows it wrongly dropped (`missing`) or kept (`extra`).
 */
export async function checkEligibilityParity(spec: ParitySpec) {
  const excluded = new Set(spec.rows.filter((r) => !r.include).map((r) => r.name));
  const uncovered = spec.clauses.filter((c) => !excluded.has(c));
  if (uncovered.length) throw new Error(`No excluded row for clause(s): ${uncovered.join(', ')}`);
  if (!spec.rows.some((r) => r.include)) throw new Error('No included row');

  const harness = await startPglitePrisma(spec.schema);
  try {
    for (const row of spec.rows) await harness.pg.exec(row.insert);
    const site = await spec.site(harness.prisma);
    const { rows } = await harness.pg.query<{ id: number }>(spec.copy);
    const copy = rows.map((r) => Number(r.id));

    const side = (ids: number[]): ParitySide => {
      const got = new Set(ids);
      return {
        missing: spec.rows.filter((r) => r.include && !got.has(r.id)).map((r) => r.name),
        extra: spec.rows.filter((r) => !r.include && got.has(r.id)).map((r) => r.name),
      };
    };
    return { site: side(site), copy: side(copy) };
  } finally {
    await harness.stop();
  }
}

/** Fails unless both sides keep exactly the included rows. */
export async function expectEligibilityParity(spec: ParitySpec) {
  const result = await checkEligibilityParity(spec);
  const clean: ParitySide = { missing: [], extra: [] };
  expect(result).toEqual({ site: clean, copy: clean });
}
