import { describe, expect, test } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/**
 * 🔴 THE REMOVAL CONTROLS STAY OUT OF THE STATIC GRAPH.
 *
 * `StickerPlacementRemoveActions` is the only part of the hover card that
 * reaches `placement.util`, and behind it the placement draft store and the
 * free-offer helpers — measured at ~57 KB of first-party source across the
 * closure. Every surface that draws a sticker paid for that statically, most of
 * them on pages where neither control could ever render.
 *
 * Nothing else can report a regression here. Re-adding a static import compiles,
 * type checks, lints, renders identically and passes every other test in the
 * repo; the only symptom is bytes on a page nobody is measuring. So this walks
 * the real value-import closure rather than grepping for a spelling of the
 * import, because a grep passes the moment someone writes it differently.
 *
 * `import type` is skipped deliberately — it erases, so a type-only edge is not
 * a regression. That is also why the negative cases below cannot be satisfied by
 * simply converting an import to `import type` and calling it fixed: doing so
 * would be a real fix.
 */

const SRC = resolve(__dirname, '..', '..', '..');
const ENTRY = join(SRC, 'components', 'Sticker', 'StickerPlacementOverlay.tsx');

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

/** Static value-imports only: no `import type`, and no `import(...)` — the latter
 * being exactly the mechanism under test. */
function valueImports(source: string): string[] {
  const out: string[] = [];
  const withClause = /^\s*import\s+(?!type\s)([\s\S]*?)from\s*['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = withClause.exec(source))) out.push(match[2]);
  const bare = /^\s*import\s*['"]([^'"]+)['"]/gm;
  while ((match = bare.exec(source))) out.push(match[1]);
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
    for (const spec of valueImports(source)) {
      const next = resolveSpec(spec, file);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

const closure = closureFrom(ENTRY);
const has = (relative: string) => [...closure].some((file) => file.endsWith(relative));

describe('the sticker overlay does not statically pull the removal controls', () => {
  // Without this the whole file is worthless: a walker that resolved nothing
  // would report an empty closure and every negative case below would pass.
  test('the closure walker actually resolved the graph (positive control)', () => {
    expect(closure.size, 'modules reached from StickerPlacementOverlay').toBeGreaterThan(20);
    expect(has('StickerPlacementHoverCard.tsx'), 'the hover card, a known static import').toBe(
      true
    );
    expect(has('StickerPlacementActions.tsx'), 'the actions row, a known static import').toBe(true);
  });

  test('🔴 placement.util is NOT in the static graph', () => {
    expect(
      has(join('Sticker', 'placement.util.ts')),
      'placement.util reached statically again — the removal controls are back in the initial bundle'
    ).toBe(false);
  });

  test('🔴 the placement draft store is NOT in the static graph', () => {
    expect(
      has('sticker-placement-draft.store.ts'),
      'the draft store reached statically — ~16 KB back on every page that draws a sticker'
    ).toBe(false);
  });

  test('🔴 the free-offer helpers are NOT in the static graph', () => {
    expect(has(join('Sticker', 'free-offer.ts')), 'free-offer reached statically').toBe(false);
  });

  test('the removal controls are reachable at all, just not statically', () => {
    const card = readFileSync(
      join(SRC, 'components', 'Sticker', 'StickerPlacementHoverCard.tsx'),
      'utf8'
    );
    // Guards the other direction: deleting the controls entirely would satisfy
    // every negative case above.
    expect(card).toContain('StickerPlacementRemoveActions');
    expect(card).toMatch(/OwnerRemove/);
    expect(card).toMatch(/ModeratorRemove/);
  });
});
