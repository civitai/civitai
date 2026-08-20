import { describe, expect, test } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { stripComments, stripCommentsAndStrings } from '../../../../test/strip-comments';

/**
 * 🔴 THE REMOVAL CONTROLS STAY OUT OF THE STATIC GRAPH.
 *
 * `StickerPlacementRemoveActions` is the only part of the hover card reaching
 * `placement.util`, and behind it the placement draft store and the free-offer
 * helpers. Deferring them takes four modules off the initial graph of every
 * route that draws a sticker without rendering this card.
 *
 * Nothing else can report that regressing. Restoring a static import compiles,
 * type checks, lints, renders identically and passes every other test in the
 * repo; the only symptom is bytes.
 *
 * 🔴 WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It asserts four named
 * modules are absent from a **source** import graph. It is not a byte budget:
 * source bytes are a ~5x overstatement of shipped bytes (~57 KB source is
 * ~10.8 KB minified here), and the real ground truth for shipped weight is a
 * production build, which no unit test can run. A budget written in the wrong
 * unit would be worse than this, not better.
 *
 * 🔴 TWO ENTRY POINTS, NOT ONE. Anchoring only on the overlay would measure the
 * surface that happens to render the card today. `StickerHistoryPanel` and
 * `StickerShopPanel` already import the card directly, and a future consumer
 * would bring the cost back on its own route while an overlay-anchored guard
 * stayed green. The card's own closure is the entry-independent claim.
 *
 * 🔴 RE-EXPORTS ARE EDGES. `export { X } from '…'` and `export * from '…'` bundle
 * exactly like an import, and this closure already contains one
 * (`client-utils/cf-images-utils.ts`). Splitting a module and re-exporting from
 * the old path is how this repo does splits — which is precisely what someone
 * would do to `placement.util` next. A walker that only matched `import` would
 * let all of it back with every test still green.
 */

const SRC = resolve(__dirname, '..', '..', '..');

const ENTRIES = {
  overlay: join(SRC, 'components', 'Sticker', 'StickerPlacementOverlay.tsx'),
  card: join(SRC, 'components', 'Sticker', 'StickerPlacementHoverCard.tsx'),
};

/**
 * The modules the deferral exists to keep out, by path rather than by basename.
 *
 * Their existence is asserted in the positive control. A bare `endsWith` on a
 * filename nothing checks would disarm itself permanently the day one of them is
 * renamed — a false green on a real regression, which is the wrong direction to
 * fail in.
 */
const COST_MODULES = [
  join(SRC, 'components', 'Sticker', 'placement.util.ts'),
  join(SRC, 'components', 'Sticker', 'free-offer.ts'),
  join(SRC, 'store', 'sticker-placement-draft.store.ts'),
  join(SRC, 'shared', 'utils', 'sticker-placement.ts'),
];

function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('~/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // node_modules — not first-party source

  for (const ext of ['.tsx', '.ts']) if (existsSync(base + ext)) return base + ext;
  for (const ext of ['.tsx', '.ts']) {
    const idx = join(base, `index${ext}`);
    if (existsSync(idx)) return idx;
  }
  return existsSync(base) && statSync(base).isFile() ? base : null;
}

/**
 * Static value edges: `import … from`, bare `import '…'`, and `export … from`.
 *
 * Comments are stripped first so a commented-out import is not an edge; strings
 * are kept, because the specifier this is reading *is* a string. `import type`
 * and `export type` are skipped — they erase, so a type-only edge costs nothing.
 * `import(…)` is not matched, which is the mechanism under test.
 */
function staticEdges(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];

  const importFrom = /^\s*import\s+(?!type\s)[\s\S]*?from\s*['"]([^'"]+)['"]/gm;
  const bareImport = /^\s*import\s*['"]([^'"]+)['"]/gm;
  const exportFrom = /^\s*export\s+(?!type\s)[\s\S]*?from\s*['"]([^'"]+)['"]/gm;
  const exportStar = /^\s*export\s*\*\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"]/gm;

  for (const re of [importFrom, bareImport, exportFrom, exportStar]) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(code))) out.push(match[1]);
  }
  return out;
}

function closureFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    seen.add(file);
    for (const spec of staticEdges(source)) {
      const next = resolveSpec(spec, file);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** Dynamic specifiers, with the export names the call site pulls off them. */
function dynamicImports(source: string): Array<{ spec: string; exports: string[] }> {
  const code = stripComments(source);
  const found: Array<{ spec: string; exports: string[] }> = [];
  const re = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code))) {
    // The `.then(m => m.Name)` that usually follows, read as a window rather than
    // a balanced match — the arrow's own parens defeat a naive `[^)]*`. Bounded
    // at the statement end, or the window runs into the next dynamic import and
    // attributes its exports to this module.
    const after = code.slice(match.index + match[0].length);
    const end = Math.min(
      ...[after.indexOf(';'), after.indexOf('import(')].filter((i) => i >= 0),
      200
    );
    const exports = [...after.slice(0, end).matchAll(/\bm\.(\w+)/g)].map((m) => m[1]);
    found.push({ spec: match[1], exports });
  }
  return found;
}

const closures = {
  overlay: closureFrom(ENTRIES.overlay),
  card: closureFrom(ENTRIES.card),
};

describe('the removal controls load on demand, not with every sticker', () => {
  /**
   * Without this the whole file is worthless twice over: a walker that resolved
   * nothing reports an empty closure and satisfies every negative case, and a
   * cost module that has been renamed is absent for the wrong reason.
   */
  test('the walker resolved a real graph, and the cost modules still exist (positive control)', () => {
    expect(closures.overlay.size, 'modules reached from StickerPlacementOverlay').toBeGreaterThan(
      20
    );
    expect(closures.card.size, 'modules reached from StickerPlacementHoverCard').toBeGreaterThan(5);

    // Depth 1 from the overlay, so this only proves the first hop resolved.
    expect([...closures.overlay].some((f) => f.endsWith('StickerPlacementHoverCard.tsx'))).toBe(
      true
    );
    // Reached only through the card, so a broken recursion is legible here
    // rather than absorbed by the size threshold above.
    expect(
      [...closures.overlay].some((f) => f.endsWith(join('shared', 'utils', 'report-helpers.ts'))),
      'a depth-2 module, reached only via the hover card'
    ).toBe(true);

    for (const costModule of COST_MODULES) {
      expect(
        existsSync(costModule),
        `${costModule} no longer exists — the negative cases below are asserting the absence of a file that cannot be present, and are silently vacuous. Update this list.`
      ).toBe(true);
    }
  });

  for (const [name, entry] of Object.entries(ENTRIES)) {
    for (const costModule of COST_MODULES) {
      const label = costModule.slice(SRC.length + 1).replace(/\\/g, '/');
      test(`🔴 ${label} is NOT in the static graph from the ${name}`, () => {
        expect(
          closures[name as keyof typeof closures].has(costModule),
          `${label} is reached statically from ${entry.slice(
            SRC.length + 1
          )} again — the removal controls are back in the initial bundle`
        ).toBe(false);
      });
    }
  }

  /**
   * The mirror of the negative claim: reachable dynamically, just not statically.
   *
   * Derived from the import sites rather than from a name written here, so it
   * survives renaming the module or moving the controls elsewhere — and it does
   * not pass on a reference that only exists in a comment or a string.
   */
  test('the controls are still reachable, through a dynamic import', () => {
    const card = readFileSync(ENTRIES.card, 'utf8');
    const dynamics = dynamicImports(card);
    expect(dynamics.length, 'dynamic imports in the hover card').toBeGreaterThan(0);

    const reachesCost = dynamics.some(({ spec }) => {
      const resolved = resolveSpec(spec, ENTRIES.card);
      if (!resolved) return false;
      const closure = closureFrom(resolved);
      return COST_MODULES.some((costModule) => closure.has(costModule));
    });

    expect(
      reachesCost,
      'no dynamic import from the hover card reaches placement.util — the controls have been deleted rather than deferred, which would satisfy every negative case above'
    ).toBe(true);
  });

  test('every export the dynamic imports name actually exists', () => {
    const card = readFileSync(ENTRIES.card, 'utf8');
    let checked = 0;

    for (const { spec, exports } of dynamicImports(card)) {
      const resolved = resolveSpec(spec, ENTRIES.card);
      if (!resolved) continue;
      const target = stripCommentsAndStrings(readFileSync(resolved, 'utf8'));
      for (const name of exports) {
        checked++;
        // `.then(m => m.Missing)` is `undefined` at runtime and renders nothing,
        // silently — no type error, because the module is only known by its path.
        expect(
          new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`).test(target),
          `${spec} does not export ${name} — the dynamic import resolves to undefined and renders nothing`
        ).toBe(true);
      }
    }

    expect(checked, 'named exports checked across the card dynamic imports').toBeGreaterThan(0);
  });

  test('the controls are rendered, not merely declared', () => {
    // Stripped, because this repo has a recorded case of a token appearing in a
    // JSDoc block counting as real wiring.
    const card = stripCommentsAndStrings(readFileSync(ENTRIES.card, 'utf8'));
    expect(card, 'the owner control is rendered').toMatch(/<OwnerRemove\b/);
    expect(card, 'the moderator control is rendered').toMatch(/<ModeratorRemove\b/);
  });
});
