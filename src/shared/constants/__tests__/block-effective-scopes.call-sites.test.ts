import { readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * CONSOLIDATION LEDGER for `effectiveBlockScopes` — `manifest.scopes ∩ approved_scopes`.
 *
 * 🔴 WHY A LEDGER AND NOT A PAIR OF LITERALS. This rule was open-coded at THREE sites before this
 * change (the `grantScopes` consent ceiling, `getInstallConfig`'s install-time disclosure, and
 * `BlockRegistry.recordInstallConsent`'s grant set) and a fourth surface — the permissions tab —
 * was about to become a fourth variant. A "these two agree" guard written as a hand-copied literal
 * on each side pins NOTHING: tighten one side and its own literal and both stay green while the two
 * have silently diverged. So this asserts the RELATIONSHIP instead — that the named modules get the
 * rule from the shared symbol and no longer carry their own copy of it.
 *
 * GROWTH-AND-SHRINK GATED, deliberately, in the shape `app-access.call-site-ledger.test.ts` already
 * established in this repo. A NEW importer must be added here consciously (is it really the same
 * rule?), and a REMOVED one fails too (did someone re-open-code it?). Either way the failure names
 * the file.
 *
 * This is a STRUCTURAL check and it is not sufficient on its own — it type-checks past a wrong
 * argument. The behavioural half lives in `block-effective-scopes.test.ts` (literal expectations for
 * the helper), `user-app-surface.orchestration.test.ts` (helper-derived expectations at the
 * permissions-tab site) and `blocks.router.getInstallConfig.test.ts` (literal expectations at the
 * two router sites).
 */

const SRC = join(process.cwd(), 'src');
const MODULE_SPECIFIER = "from '~/shared/constants/block-effective-scopes'";

/** Every module that is expected to consume the shared rule, and what it uses it for. */
const EXPECTED_CALL_SITES: Record<string, string> = {
  'server/routers/blocks.router.ts':
    'grantScopes consent ceiling + getInstallConfig install-time disclosure',
  'server/services/block-registry.service.ts': 'recordInstallConsent grant set',
  'server/services/blocks/user-app-surface.service.ts':
    'listMyScopeGrants — the /apps/activity permissions tab',
};

/**
 * The signature of every pre-existing open-coded copy: a `Set` built straight from the
 * `approvedScopes` column, to be `.has()`-tested against the manifest array. Matching this is how
 * the guard notices someone re-deriving the rule locally instead of calling the helper.
 */
const OPEN_CODED_INTERSECTION = /new Set\(\s*[A-Za-z0-9_.?[\]]*approvedScopes/i;

function read(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8');
}

/** Recursive walk — no `glob` dependency in this repo, so this is hand-rolled on purpose. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(relative(SRC, full).split(sep).join('/'));
    }
  }
  return out;
}

/** Strip comments — the modules deliberately DISCUSS the old shape in prose. */
function codeOnly(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('effectiveBlockScopes consolidation ledger', () => {
  // ── INSTRUMENT VALIDATION. Both halves, before any verdict below is believed: the walk must
  // actually find files, and the open-coded-intersection regex must actually match the shape it
  // claims to detect. A reassuring "0 offenders" from a probe wired to nothing is indistinguishable
  // from a real pass.
  it('the source walk finds files and the open-coded regex matches a known-bad sample', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('shared/constants/block-effective-scopes.ts');
    // POSITIVE control — the exact shape the three sites used to carry.
    expect(
      OPEN_CODED_INTERSECTION.test('const approved = new Set(block.approvedScopes ?? []);')
    ).toBe(true);
    expect(
      OPEN_CODED_INTERSECTION.test('const approved = new Set(opts.approvedScopes ?? []);')
    ).toBe(true);
    // NEGATIVE control — the consolidated shape must NOT match, or the guard below would be
    // permanently red and therefore worthless.
    expect(
      OPEN_CODED_INTERSECTION.test(
        'const ceiling = new Set(effectiveBlockScopes(block.manifest, block.approvedScopes));'
      )
    ).toBe(false);
  });

  it('every expected call site imports the shared symbol', () => {
    const missing = Object.keys(EXPECTED_CALL_SITES).filter(
      (file) => !read(file).includes('import { effectiveBlockScopes }')
    );
    expect(missing).toEqual([]);
  });

  it('every expected call site actually CALLS it (an import alone is not use)', () => {
    const notCalled = Object.keys(EXPECTED_CALL_SITES).filter(
      (file) => !codeOnly(read(file)).includes('effectiveBlockScopes(')
    );
    expect(notCalled).toEqual([]);
  });

  // 🔴 GROWTH-AND-SHRINK GATE. `EXPECTED_CALL_SITES` must be the COMPLETE set of production
  // importers under `src/`, so a new consumer cannot appear without a deliberate edit here and an
  // existing one cannot quietly drop the shared rule.
  it('the ledger is the complete set of production importers', () => {
    const importers = sourceFiles(SRC)
      .filter((f) => f !== 'shared/constants/block-effective-scopes.ts')
      .filter((f) => read(f).includes(MODULE_SPECIFIER))
      .sort();
    expect(importers).toEqual(Object.keys(EXPECTED_CALL_SITES).sort());
  });

  // 🔴 NO CONSOLIDATED SITE MAY RE-OPEN-CODE THE RULE — the thing that would silently regenerate
  // the divergence the consolidation removed.
  it('no consolidated module still builds its own approved-scope Set to intersect with', () => {
    const offenders = Object.keys(EXPECTED_CALL_SITES).filter((file) =>
      OPEN_CODED_INTERSECTION.test(codeOnly(read(file)))
    );
    expect(offenders).toEqual([]);
  });
});
