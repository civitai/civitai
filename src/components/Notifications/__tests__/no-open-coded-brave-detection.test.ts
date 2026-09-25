import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `navigator.brave` must be read in ONE place: `src/utils/device-helpers.ts`.
 *
 * This is not style. The detection was open-coded at two sites — ad-blocking detection and the
 * web-push failure message — and the two copies had already DIVERGED: one handled a rejected
 * `isBrave()`, the other left it as an unhandled rejection. That is the shape consolidation exists to
 * expose, and nothing noticed it for as long as both copies existed.
 *
 * Consolidating fixed it once. This test is what makes it stay fixed: a tidy-up that re-inlines
 * `navigator.brave` anywhere reintroduces the same divergence silently, because both call sites
 * still "work" and only their rejection behaviour differs. `src/components/Ads` has no tests of its
 * own, so without this guard that half of the consolidation is pinned by nothing at all.
 */

const SRC = path.resolve(process.cwd(), 'src');
/** The one module allowed to touch it. Callers differ in what they do with the answer, never in how they get it. */
const OWNER = path.join(SRC, 'utils/device-helpers.ts');
const BRAVE_READ = /navigator\s*(?:as[^)]*?)?\)?\s*\.\s*brave|\bbrave\?\.\s*isBrave|\['brave'\]/;

function sourceFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFilesUnder(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('navigator.brave is read in exactly one module', () => {
  it('has the tree and the owner where this test expects them', () => {
    // Asserted before anything is read: a moved directory or a renamed owner would make every
    // assertion below vacuously true, which is the same silent-pass failure the guard exists to stop.
    expect(fs.existsSync(SRC)).toBe(true);
    expect(fs.existsSync(OWNER)).toBe(true);
    expect(sourceFilesUnder(SRC).length).toBeGreaterThan(500);
  });

  it('positive control: the pattern DOES match the owner', () => {
    // Without this, a regex that matches nothing anywhere would report a clean sweep forever.
    expect(BRAVE_READ.test(fs.readFileSync(OWNER, 'utf8'))).toBe(true);
  });

  it('no other production file reads navigator.brave', () => {
    const offenders = sourceFilesUnder(SRC)
      .filter((file) => file !== OWNER)
      .filter((file) => BRAVE_READ.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));

    expect(offenders).toEqual([]);
  });
});
