import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * 🔴 SOURCE GATE — `guardedProcedureAllowUnverifiedEmail` is an allowlist, not a convenience.
 *
 * The email-verification gate lives on `guardedProcedure`, so a new content mutation inherits it
 * without anyone remembering to. That property survives only while the exemption stays rare: the
 * cheapest way to make a refusal go away is to swap the procedure, and nothing else in the toolchain
 * would say a word — the code compiles, the feature works, and the gate is quietly gone from that
 * surface. Every entry below is a procedure that would otherwise 403 something the refusal is not
 * meant to reach.
 *
 * Adding one is allowed. Adding one WITHOUT saying so here is what this stops. If you are widening it,
 * put the reason in the table and in the PR.
 */

const ROUTERS = path.resolve(__dirname, '../../../../src/server/routers');
const EXEMPT = 'guardedProcedureAllowUnverifiedEmail';

/** file → the procedures allowed to use it, and why. */
const ALLOWLIST: Record<string, { procedures: string[]; why: string }> = {
  'report.router.ts': {
    procedures: ['create', 'createAppeal'],
    why: 'Reporting abuse, and appealing your own restriction, are never gated.',
  },
  'games.router.ts': {
    procedures: ['getPlayer', 'getImagesQueue', 'getHistory'],
    why: 'Queries the New Order UI renders from — a refusal blanks the page.',
  },
  'feedback.router.ts': {
    procedures: ['getArea', 'create'],
    why: 'Both, together: the router already requires that whoever sees the prompt can submit.',
  },
  'user.router.ts': {
    procedures: ['updateBrowsingMode'],
    why: 'A browsing preference, not a content action.',
  },
};

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** `name: guardedProcedureAllowUnverifiedEmail` — the procedure definitions, not the import line. */
function exemptProceduresIn(source: string): string[] {
  const body = stripComments(source);
  const matches = body.matchAll(new RegExp(`(\\w+)\\s*:\\s*${EXEMPT}\\b`, 'g'));
  return [...matches].map((m) => m[1]).sort();
}

function routerFiles(): string[] {
  return readdirSync(ROUTERS).filter((f) => f.endsWith('.ts'));
}

describe('no unscoped email-verification exemption', () => {
  it('is used only in the allowlisted routers', () => {
    const using = routerFiles().filter((f) =>
      stripComments(readFileSync(path.join(ROUTERS, f), 'utf8')).includes(EXEMPT)
    );
    expect(using.sort()).toEqual(Object.keys(ALLOWLIST).sort());
  });

  it.each(Object.entries(ALLOWLIST))('exempts exactly the listed procedures in %s', (file) => {
    const source = readFileSync(path.join(ROUTERS, file), 'utf8');
    expect(exemptProceduresIn(source)).toEqual([...ALLOWLIST[file].procedures].sort());
  });

  /**
   * Without this the guard passes trivially the day someone renames the export: every file stops
   * matching, `using` comes back empty, and an empty list still has to equal a non-empty allowlist —
   * so it would fail here rather than silently. This asserts the positive case exists at all.
   */
  it('finds the export it is guarding', () => {
    const trpc = readFileSync(path.resolve(__dirname, '../../../../src/server/trpc.ts'), 'utf8');
    expect(trpc).toContain(`export const ${EXEMPT} =`);
    expect(Object.values(ALLOWLIST).flatMap((e) => e.procedures).length).toBeGreaterThan(0);
  });
});
