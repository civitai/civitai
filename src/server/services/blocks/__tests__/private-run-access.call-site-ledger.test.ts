import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';
import { stripCommentsAndStrings } from '../../../../../test/strip-comments';

/**
 * THE SSR⇄MINT SEAM, LEDGERED — and it is the guard this whole feature is shaped
 * around.
 *
 * ── THE DEFECT CLASS, WHICH HAS ALREADY HAPPENED ON THIS EXACT SURFACE ──────────
 * 🔴 THE PRIVATE-RUN BUG TO PREVENT IS AN SSR↔MINT ASYMMETRY. The dev-tunnel SSR route
 * mounts an owned app at ANY status while the page mint required `status: 'approved'`,
 * so the page rendered and then could not authenticate —
 * `tryDevTunnelOwnedNonApprovedMint` exists only to close that gap after the fact. Two
 * surfaces with two independently-written gates regrow it. So this file pins a
 * RELATIONSHIP over a population rather than any one component:
 *
 *   1. the complete set of `resolvePrivateRunAccess` call sites is EXACTLY two;
 *   2. the complete set of `resolvePageBlockBySlug` call sites and of `resolvePageBlock`
 *      call sites are each EXACTLY one, and both of those resolvers stay
 *      `approved`-only — so a future path cannot quietly adopt an approved-only
 *      resolver for a non-approved surface, nor add a third caller to either;
 *   3. `resolvePrivateRunPageBlock` — the non-approved resolver — is reachable from the
 *      predicate and from NOWHERE else, so no route can take the status bypass without
 *      the role check.
 *
 * ── WHY IT IS A SOURCE-TEXT GUARD, AND WHY THAT IS NOT SUFFICIENT ALONE ─────────
 * These handlers cannot be invoked without the whole auth stack, so the ledger is
 * STRUCTURAL — and a structural check TYPE-CHECKS PAST A WRONG ARGUMENT. It cannot see
 * a call site that passes the wrong slug, the wrong pool, or a hardcoded `true` for the
 * flag. That is why the behavioural half — `private-run-seam-agreement.test.ts` — is
 * mandatory, not decorative: it drives ONE fixture through both consumers' argument
 * shapes and asserts they AGREE. Neither half is sufficient: this one cannot see a
 * wrong value, that one cannot see a missing call.
 *
 * ⚠️ `stripCommentsAndStrings` REMOVES STRING LITERALS AS WELL AS COMMENTS, which is
 * what makes the call-site scan immune to a name written in prose — and which means a
 * literal like a status value CANNOT be asserted against `CODE`. Those assertions read
 * `raw()` instead. Getting this wrong is silent in the safe direction here (the
 * assertion fails), but the asymmetry is worth naming.
 */

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every non-test .ts/.tsx under src/, as repo-relative POSIX-ish paths. */
function sourceFiles(): string[] {
  return walk(join(ROOT, 'src'))
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    .filter((f) => !/__tests__|\.test\.tsx?$|(^|\/)src\/tests\//.test(f));
}

const FILES = sourceFiles();
const CODE = new Map(
  FILES.map((f) => [f, stripCommentsAndStrings(readFileSync(join(ROOT, f), 'utf8'))] as const)
);

/** Raw file text, for assertions about literals (which `CODE` has stripped). */
function raw(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

/**
 * Where each scanned symbol is DEFINED, excluded from its own caller set.
 *
 * 🔴 A HAND-WRITTEN MAP, NOT A REGEX, AND THE REASON IS A BUG THIS FILE ALREADY HAD. The
 * first draft derived it with `/function <name>/`, which cannot see a `static async`
 * CLASS METHOD — and three of the four symbols here are exactly that (`BlockRegistry` is
 * a class of statics). So `block-registry.service.ts` was silently counted as a CALLER
 * of its own methods, and the resolver ledger would have demanded an entry for the file
 * that defines it. An explicit map is also the honest shape: "where is this defined" is
 * a fact about the repo, not something to infer with a pattern that can be wrong.
 */
const DEFINED_IN: Record<string, string> = {
  resolvePrivateRunAccess: 'src/server/services/blocks/private-run-access.service.ts',
  resolvePrivateRunPageBlock: 'src/server/services/block-registry.service.ts',
  resolvePageBlockBySlug: 'src/server/services/block-registry.service.ts',
  resolvePageBlock: 'src/server/services/block-registry.service.ts',
};

/** Files whose CODE (comments and string literals stripped) calls `name(`. */
function callersOf(name: string): string[] {
  const re = new RegExp(`\\b${name}\\s*\\(`);
  const home = DEFINED_IN[name];
  return FILES.filter((f) => re.test(CODE.get(f)!) && f !== home).sort();
}

describe('the private-run seam — instrument validation', () => {
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    // A broken walk or a regex that matches nothing would make every assertion below
    // vacuously true. Prove the instrument works before reading its verdict.
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain('src/server/services/blocks/private-run-access.service.ts');
    expect(FILES).toContain('src/pages/api/v1/block-tokens/index.ts');
    expect(FILES).toContain('src/pages/apps/private-run/[slug]/[[...path]].tsx');
  });

  it('NEGATIVE CONTROL: a definitely-absent predicate matches nothing', () => {
    expect(callersOf('resolvePrivateRunAccessNoSuchFunction')).toEqual([]);
  });

  it('🔴 CONTROL: the scan reads CODE, so a mention in a COMMENT is not a call site', () => {
    // The failure this prevents is specific and has bitten a sibling ledger: a regex
    // over RAW source turns green the moment somebody writes the predicate's name in a
    // doc comment, with the file calling nothing. Several files legitimately NAME
    // `resolvePrivateRunAccess` in prose — the registry resolver's docblock and the
    // middleware's claim docblock among them — and none of them may count.
    const mentionsInProse = FILES.filter((f) => {
      const raw = readFileSync(join(ROOT, f), 'utf8');
      return raw.includes('resolvePrivateRunAccess') && !CODE.get(f)!.includes('resolvePrivateRunAccess');
    });
    // At least one such file must exist, or this control is proving nothing.
    expect(mentionsInProse.length).toBeGreaterThan(0);
    for (const f of mentionsInProse) {
      expect(callersOf('resolvePrivateRunAccess')).not.toContain(f);
    }
  });
});

describe('the private-run seam — the call-site ledger [INV]', () => {
  /**
   * 🔴 ENUMERATED EQUALITY, NEVER CONTAINMENT. A third consumer fails here, and so does
   * deleting one. If you are here because a count is off, the fix is to decide whether
   * the new surface should share this predicate — not to bump the list.
   */
  const PREDICATE_CALLERS = [
    'src/pages/api/v1/block-tokens/index.ts',
    'src/pages/apps/private-run/[slug]/[[...path]].tsx',
  ];

  it('resolvePrivateRunAccess has EXACTLY the two ledgered callers (SSR + mint)', () => {
    expect(callersOf('resolvePrivateRunAccess')).toEqual(PREDICATE_CALLERS.sort());
  });

  it('🔴 resolvePrivateRunPageBlock is reachable ONLY from the predicate', () => {
    // The non-approved resolver takes NO access decision. A route calling it directly
    // would be a status bypass with no role check — the exact shape the shared predicate
    // exists to make impossible. Its only legitimate caller is the predicate.
    expect(callersOf('resolvePrivateRunPageBlock')).toEqual([
      'src/server/services/blocks/private-run-access.service.ts',
    ]);
  });

  it('the approved-only resolvers keep EXACTLY one caller each, and stay approved-only', () => {
    // Non-goal #1 and #2 of the design, as a test. If a new surface adopts one of these
    // resolvers, or if one of them loses its status filter, the private path has started
    // shadowing the public one.
    expect(callersOf('resolvePageBlockBySlug')).toEqual([
      'src/pages/apps/run/[slug]/[[...path]].tsx',
    ]);
    expect(callersOf('resolvePageBlock')).toEqual(['src/pages/api/v1/block-tokens/index.ts']);

    // Both resolvers must still pin the approved status. Asserted as the literal query
    // fragments, because that is what a mutation would have to remove — and read from
    // RAW source, because `CODE` has had its string literals stripped.
    const registry = raw('src/server/services/block-registry.service.ts');
    expect(registry).toContain("status: 'approved'");
    expect(registry).toContain("ab.status !== 'approved'");
    // And the PRIVATE resolver must carry the mirror-image branch: an approved app is
    // refused there, so the two surfaces partition the status space rather than overlap.
    expect(registry).toContain("if (ab.status === 'approved') return { ok: false, reason: 'approved' }");
  });

  it('🔴 the private route does NOT import either approved-only resolver', () => {
    // The strongest single statement of the non-goal: the private surface cannot reach
    // the public resolvers at all, so it cannot be "fixed" by widening one of them.
    const route = CODE.get('src/pages/apps/private-run/[slug]/[[...path]].tsx')!;
    expect(route).not.toContain('resolvePageBlockBySlug');
    expect(route).not.toContain('resolvePageBlock');
    expect(route).toContain('resolvePrivateRunAccess');
  });

  it('the public run route is UNMODIFIED in the ways that matter', () => {
    // It must still record the play and still use the approved-only resolver — the two
    // things the private route deliberately does NOT do. If the public route lost
    // `recordAppListingOpen`, the omission on the private side would stop being a
    // distinction and the analytics reasoning behind it would be void.
    const pub = CODE.get('src/pages/apps/run/[slug]/[[...path]].tsx')!;
    expect(pub).toContain('recordAppListingOpen');
    expect(pub).toContain('resolvePageBlockBySlug');
    const priv = CODE.get('src/pages/apps/private-run/[slug]/[[...path]].tsx')!;
    // 🔴 The private route must NOT record a play. A private review run is not a play,
    // and recording it would move a suspended app's owner-visible analytics — telling a
    // bad actor exactly when review is happening.
    expect(priv).not.toContain('recordAppListingOpen');
    // Nor plant a dead link in the viewer's own recents (both its link shapes 404 for a
    // suspended app).
    expect(priv).not.toContain('recordRecentlyOpenedApp');
  });

  it('BOTH consumers evaluate the flag for the caller and pass it in', () => {
    // The structural half of "fail-closed on both surfaces". The behavioural half is
    // below. Neither consumer may call the predicate without a `privateRunEnabled`
    // argument — the parameter is required, so this is really a check that neither one
    // hardcodes `true`.
    for (const f of PREDICATE_CALLERS) {
      const code = CODE.get(f)!;
      expect(code, `${f} must evaluate the flag`).toContain('isAppBlocksPrivateRunEnabled');
      expect(code, `${f} must not hardcode the flag`).not.toContain('privateRunEnabled: true');
    }
  });
});

/**
 * 🔴 THE BEHAVIOURAL HALF OF THIS SEAM LIVES IN
 * `private-run-seam-agreement.test.ts`, NOT HERE, and the split is mechanical rather
 * than stylistic: that half needs a mocked database client, and a module mock is hoisted
 * file-wide — it would replace part of the very module graph this ledger walks. Keeping
 * the structural scan in a file with NO module mocks is what lets it read the real
 * repository.
 *
 * ⚠️ AND THAT PARAGRAPH USED TO NAME THE MOCKED SPECIFIER LITERALLY, WHICH TRIPPED
 * `no-direct-shared-module-mock` — that guard scans RAW source, so prose describing a
 * mock is indistinguishable to it from the mock itself. Reworded rather than
 * allowlisted: an allowlist entry here would have been a permanent exemption bought to
 * accommodate a sentence.
 *
 * DO NOT treat this file as the whole guard. It counts call sites; it cannot see a call
 * site that passes the wrong slug, the wrong pool, or a hardcoded flag. The agreement
 * test is what covers that, and the two are a pair.
 */
