import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Reachability guard for the fabricated-zero fix.
 *
 * The analytics half of this bug (#3557) shipped for months while looking fixed,
 * because the DTO carried a `notOwned` field that the panel declared in its types
 * and never branched on. A discriminator nothing reads is not a guard. The
 * behavioural guard itself is covered by RevenuePanel.browser.test.tsx; what THIS
 * file pins is that the guarded component is the only way a human ever sees
 * `getMyRevenue` — so a future page cannot quietly reintroduce an unguarded
 * reader of the proc and render never-measured zeros as earnings.
 *
 * Deliberately a source-level assertion: the two consumers are Next pages that
 * import `createServerSideProps`, so they cannot be mounted in a test (the repo
 * has no page-level render tests for exactly this reason).
 */

const SRC = join(process.cwd(), 'src');
const PANEL = 'src/components/AppBlocks/RevenuePanel.tsx';
const PAGES = ['src/pages/apps/revenue.tsx', 'src/pages/apps/[appBlockId]/revenue.tsx'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function rel(p: string) {
  return p
    .slice(process.cwd().length + 1)
    .split('\\')
    .join('/');
}

describe('RevenuePanel wiring — the discriminator has exactly one reader, and it is live', () => {
  const files = walk(SRC);

  it('sanity: the tree walk found the panel and both pages (positive control)', () => {
    // Without this, an empty/misrooted walk would make every "no other caller"
    // assertion below vacuously true.
    expect(files.length).toBeGreaterThan(500);
    const found = files.map(rel);
    expect(found).toContain(PANEL);
    for (const p of PAGES) expect(found).toContain(p);
  });

  it('RevenuePanel is the ONLY component that queries blocks.getMyRevenue', () => {
    const callers = files
      .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      .filter((f) => /trpc\.blocks\.getMyRevenue\.useQuery/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort();
    // If this fails with an EXTRA entry, that new consumer must branch on
    // `unavailable` too (or render <RevenuePanel>) before it ships.
    expect(callers).toEqual([PANEL]);
  });

  it('both revenue pages import and render the shared panel', () => {
    for (const page of PAGES) {
      const src = readFileSync(join(process.cwd(), page), 'utf8');
      expect(src).toMatch(
        /import \{ RevenuePanel \} from '~\/components\/AppBlocks\/RevenuePanel'/
      );
      expect(src).toMatch(/<RevenuePanel[\s/>]/);
    }
  });

  it('neither page still renders revenue markup of its own', () => {
    // The pre-change pages each had a private copy of the summary cards, which is
    // how one bug got two unguarded renderers. Consolidation is the structural
    // half of this fix; this keeps it consolidated.
    for (const page of PAGES) {
      const src = readFileSync(join(process.cwd(), page), 'utf8');
      expect(src).not.toMatch(/Confirmed \(unpaid\)/);
      expect(src).not.toMatch(/Recent attributions/);
    }
  });
});
