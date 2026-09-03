import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { FEATURE_NOTICES } from '~/components/Alerts/notice-registry';

/**
 * 🔴 SOURCE GATE — the CALL-SITE LEDGER for feature notices.
 *
 * WHAT THIS IS NOT. It does not pin any notice's id, and it cannot: a wrong key
 * at a call site is a BEHAVIOURAL fault, so the thing that catches it is
 * `notice-callsite.browser.test.tsx`, which mounts each component, clicks each
 * dismiss control, and asserts the `alertId` actually sent. Read that file
 * first — this one exists only to keep its population complete.
 *
 * WHAT IT IS. The behavioural guard covers the call sites that existed when it
 * was written. Nothing stops a tenth site being added tomorrow with no test at
 * all, and the suite would stay green — the same silence that let a
 * mis-pointable id land in the first place. So this enumerates every
 * `FEATURE_NOTICES.<key>` reference in the app graph and pins the
 * file → keys map. It fails when the set GROWS (a new site with no guard),
 * SHRINKS (a site deleted), or MOVES (a file re-pointed at a different entry),
 * and the failure message says which test file the new site has to be added to.
 *
 * 🔴 The expected table is HAND-TYPED — file paths and key names both. It is
 * deliberately not derived from a scan of the same source it is checking, which
 * would agree with anything.
 *
 * KNOWN LIMIT, stated because it is the interesting one: this is blind to a
 * WITHIN-FILE swap. `ReferralDashboardFull` uses three keys; exchanging which
 * const is wired to which button leaves the file's key set identical and this
 * gate passes. That case is covered — and was mutation-checked — only by the
 * behavioural file. A ledger constrains the population, never the wiring.
 */

const SRC = path.resolve(__dirname, '../../../../src');

const CODE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__screenshots__']);

/** The registry's own definition — it names every key by construction. */
const REGISTRY_FILE = 'components/Alerts/notice-registry.ts';

/**
 * Test files are not call sites. `__tests__/` covers most of them, but this
 * repo also places `*.browser.test.tsx` directly beside the component it
 * exercises (see `src/components/generation_v2/inputs/`), so the directory skip
 * alone would let a future notice test read as a production call site and fail
 * this gate for writing the very guard it asks for.
 */
const isTestFile = (name: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXTENSIONS.has(path.extname(entry)) && !isTestFile(entry)) out.push(full);
  }
  return out;
}

/**
 * Strip comments before matching. This file and several components write
 * `FEATURE_NOTICES.<something>` out in prose; an unstripped scan would count a
 * documentation example as a call site.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** file (posix, relative to src/) → the registry keys it references, sorted. */
function scanCallSites(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel === REGISTRY_FILE) continue;
    const keys = new Set<string>();
    for (const m of stripComments(readFileSync(file, 'utf8')).matchAll(
      /FEATURE_NOTICES\.([A-Za-z0-9_$]+)/g
    )) {
      keys.add(m[1]);
    }
    if (keys.size > 0) found[rel] = [...keys].sort();
  }
  return found;
}

// 🔴 Hand-written. Every entry names the test that proves that file dismisses
// the id it means to. Adding a row here without adding the behavioural case is
// the one way to defeat this gate, and it takes a deliberate edit to do it.
const CALL_SITE_LEDGER: Record<string, string[]> = {
  // Guarded by notice-callsite.browser.test.tsx
  'components/Modals/BuyBuzzModal.tsx': ['earnBlueBuzzRewards'],
  'components/RemixGallery/RemixGalleryExplainer.tsx': ['remixGalleryExplainer'],
  'components/Referrals/ReferralDashboard.tsx': ['referralKickback', 'referralLiteOnboarding'],
  'components/Referrals/ReferralDashboardFull.tsx': [
    'referralHowItWorks',
    'referralKickback',
    'referralTokenShop',
  ],
  // Guarded by feature-notice.characterization.browser.test.tsx
  'components/Alerts/NavCustomizeNotice.tsx': ['navCustomize'],
  'components/Alerts/YellowBuzzMigrationNotice.tsx': ['yellowBuzzMigration'],
  'components/Buzz/CryptoDeposit/OnrampGuidance.tsx': ['cryptoOnrampGuidance'],
};

describe('feature-notice call-site ledger', () => {
  const actual = scanCallSites();

  test('the scanner can see call sites at all', () => {
    // Positive control. Every assertion below is a comparison against a scan,
    // and a scan wired to nothing returns `{}` — which would make an emptied
    // ledger pass and a "no new call sites" claim vacuous.
    expect(Object.keys(actual).length).toBeGreaterThan(0);
    expect(actual['components/Alerts/NavCustomizeNotice.tsx']).toContain('navCustomize');
  });

  test('every file referencing FEATURE_NOTICES is a known, guarded call site', () => {
    const unknown = Object.keys(actual).filter((f) => !(f in CALL_SITE_LEDGER));
    expect(
      unknown,
      'A new feature-notice call site appeared. Add a behavioural case to ' +
        'src/components/Alerts/__tests__/notice-callsite.browser.test.tsx that mounts it, ' +
        'clicks its dismiss control and asserts the alertId as a HAND-TYPED literal — then ' +
        'add it to CALL_SITE_LEDGER here. Do not add it to the ledger alone.'
    ).toEqual([]);
  });

  test('every ledgered call site still exists', () => {
    const missing = Object.keys(CALL_SITE_LEDGER).filter((f) => !(f in actual));
    expect(
      missing,
      'A ledgered call site no longer references FEATURE_NOTICES. If the notice was removed, ' +
        'drop its row here AND its behavioural case — and remember the id stays in real users’ ' +
        'dismissedAlerts either way.'
    ).toEqual([]);
  });

  test('each call site references exactly the registry keys the ledger pins', () => {
    expect(
      actual,
      'The set of registry keys a call site reaches for has changed. If a file was re-pointed ' +
        'at a different notice, that is the exact fault this gate exists for.'
    ).toEqual(CALL_SITE_LEDGER);
  });

  test('no registry entry is dead — every notice has at least one call site', () => {
    const referenced = new Set(Object.values(actual).flat());
    const orphans = Object.keys(FEATURE_NOTICES).filter((k) => !referenced.has(k));
    expect(
      orphans,
      'A registry entry is referenced by nothing. It renders nowhere, so no behavioural test ' +
        'can guard it — remove the entry or wire it up.'
    ).toEqual([]);
  });
});

/**
 * 🔴 THE AUDIENCE LEDGER — a second population gate, for the same reason as the
 * first.
 *
 * `useFeatureNotice` computes `isInAudience`, but a hook can only OFFER an
 * answer; a call site that never reads it renders the notice to everyone and
 * the suite stays green. That is phase 1's warning one level up — the field is
 * read by the hook, and then the hook's answer is the thing nothing reads.
 *
 * WHAT THIS IS NOT: it is structural, and structural is weak. It cannot tell
 * `if (!isInAudience) return null` from `if (isInAudience) return null`. The
 * BEHAVIOURAL claim — a targeted notice is withheld from a non-member — is
 * asserted against the hook's return value in
 * `useFeatureNotice.audience.test.ts`, in this same project, and was
 * mutation-checked. This gate exists only so that claim's population cannot
 * silently grow a member that skips it.
 */
describe('feature-notice audience ledger', () => {
  const actual = scanCallSites();

  // 🔴 Hand-typed, like CALL_SITE_LEDGER above. Deriving this from the registry
  // would make it agree with a notice that silently loses its audience.
  const TARGETED_KEYS = ['remixGalleryExplainer'];

  /** Files that must read the hook's audience answer, derived from the ledger. */
  const filesReferencing = (key: string) =>
    Object.keys(CALL_SITE_LEDGER).filter((f) => CALL_SITE_LEDGER[f].includes(key));

  const readsAudience = (relFile: string) =>
    /\bisInAudience\b/.test(stripComments(readFileSync(path.join(SRC, relFile), 'utf8')));

  test('the hand-typed targeted set matches the registry', () => {
    // Both directions. A notice gaining an audience with no row here would
    // otherwise be unguarded; a notice LOSING one silently would leave this
    // demanding a gate that no longer exists.
    const fromRegistry = Object.entries(FEATURE_NOTICES)
      .filter(([, notice]) => (notice as { audience?: unknown }).audience !== undefined)
      .map(([key]) => key)
      .sort();
    expect(
      fromRegistry,
      'A notice gained or lost an `audience`. Update TARGETED_KEYS here, and make sure every ' +
        'call site for it reads `isInAudience` from useFeatureNotice.'
    ).toEqual([...TARGETED_KEYS].sort());
  });

  test('the audience scanner can see a consumer at all', () => {
    // Positive control, and a real one: it names a file that DOES read the
    // field and a file that legitimately does not. Without the second half a
    // detector wired to `true` would pass.
    expect(readsAudience('components/RemixGallery/RemixGalleryExplainer.tsx')).toBe(true);
    expect(readsAudience('components/Alerts/NavCustomizeNotice.tsx')).toBe(false);
  });

  test('every call site of a TARGETED notice reads isInAudience', () => {
    const unguarded = TARGETED_KEYS.flatMap((key) =>
      filesReferencing(key)
        .filter((file) => !readsAudience(file))
        .map((file) => `${file} (notice: ${key})`)
    );
    expect(
      unguarded,
      'A call site renders a notice that declares an `audience` without reading `isInAudience` ' +
        'from useFeatureNotice, so it would announce the feature to users who do not have it. ' +
        'AND `isInAudience` into its render condition.'
    ).toEqual([]);
  });

  test('a targeted notice actually has call sites to guard', () => {
    // Positive control on the test above: `filesReferencing` returning [] would
    // make an empty `unguarded` prove nothing.
    for (const key of TARGETED_KEYS) {
      expect(filesReferencing(key).length).toBeGreaterThan(0);
    }
  });
});
