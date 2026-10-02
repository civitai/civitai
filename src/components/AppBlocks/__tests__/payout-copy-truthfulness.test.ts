import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { stripComments } from '../../../../test/strip-comments';

/**
 * Money copy must not describe a disbursement that does not run.
 *
 * Three committed assertions described an automated payout pipeline that does not exist.
 * TWO were user-visible strings — "Payouts are batched weekly" and "Will be included in
 * your next payout" — both reachable by the `appBlocksAuthor` cohort: the Earnings tab is
 * one click from the default tab on the listing editor, and /apps/revenue is linked from
 * Apps. The THIRD was a docblock claiming the earnings proc "grants it to any accepted
 * editor with a session", which is reachable by no cohort at all — it misleads the next
 * author rather than a user. The distinction is kept because this file's whole thesis is
 * that committed prose must be machine-checkable, and "three user-visible strings" would
 * have been exactly the kind of unchecked claim it exists to forbid.
 *
 * Nothing could have caught them, because each was prose agreeing only with other prose.
 * `mintPayoutForOwner` was the ONLY writer of `paidOutAt`/`payoutId` and never had a
 * production caller; the weekly `bulk-payout-block-attributions` job was registered and did
 * run, but aggregated, logged to Axiom and wrote nothing. So the cadence was invented, and
 * the copy was the only place it existed.
 *
 * 🔴 BOTH ARE NOW GONE, WHICH MAKES THE STATE GUARDS STRONGER, NOT UNNECESSARY. The mint and
 * the stub cron were removed rather than kept inert, so the STATE half below no longer asks
 * "is the rail still unwired" — it asserts the rail DOES NOT EXIST: zero references to the
 * mint in any non-test code file under `src`/`packages`/`apps`/`scripts`, and no
 * `bulk-payout-block-attributions` module and no registration of it in the job array. Each
 * half carries a positive control, because "0 occurrences" and "a scan wired to nothing" are
 * otherwise the same observation.
 *
 * 🔴 THIS ASSERTS A RELATIONSHIP, NOT A VOCABULARY, and it has both directions — the shape
 * `standaloneWordingCallSites.test.ts` uses in the next directory for the same reason.
 *
 *   SHRINK — the two user-visible sentences are pinned WHOLE and normalised. A guard that
 *   greps for a banned word ("payout", "weekly") is walked by rewording, which on a money
 *   surface is the exact failure mode: the next sentence promising a cadence will not reuse
 *   this one's vocabulary. The cost is that a cosmetic reword goes red for a non-defect.
 *   Pay it — re-reading the state guards is the point, and it makes the claim
 *   machine-readable rather than a sentence asking the next author to remember.
 *
 *   GROW — an exact ledger of the files that render settlement buckets, so a THIRD money
 *   surface on a file nobody listed also fails. The SHRINK half only ever knew about files
 *   it was told about by name, and being told about two of three is how this shipped. It is
 *   a STRUCTURAL ledger and not a cadence-phrase scan for a measured reason recorded at
 *   that test.
 *
 *   STATE — the copy is only true while the rail is unwired and the job writes nothing, so
 *   both are asserted directly rather than trusted. The rail half is an exact per-file
 *   OCCURRENCE ledger over RAW text, for the polarity reason recorded at that test.
 *
 * If you are here because you BUILT a payout rail: the `payout rail does not exist` guard is
 * the one that should have failed first. Both copy strings may then legitimately promise a
 * cadence again — update them and this file together, in that order.
 */

const REPO_ROOT = join(__dirname, '../../../..');

/**
 * Every tree a production caller could live in. `src/` alone would make the guard's own
 * headline — "no production caller" — wider than what it measures: a rail wired from
 * `packages/`, `apps/` or `scripts/` would leave it green while money moved.
 *
 * Because the ledger counts occurrences of the bare IDENTIFIER in raw text, the shapes a
 * call-shaped regex misses are covered here without a type-aware pass: a renaming import,
 * a bare callback reference (`rows.map(mintPayoutForOwner)`), `.call`/`.apply` and a
 * computed access all add an occurrence, and the import statement itself is the tripwire.
 */
const CALLER_ROOTS = ['src', 'packages', 'apps', 'scripts'];

/**
 * The trees searched for surfaces that show a user App Blocks money. The GROW half pins the
 * SET of such files, so a new one has to be looked at rather than silently inheriting — or
 * failing to inherit — the accrual disclosure the existing two carry.
 */
const MONEY_COPY_ROOTS = ['src/components/AppBlocks', 'src/components/Apps', 'src/pages/apps'];

const REVENUE_PAGE = 'src/pages/apps/revenue.tsx';
const REVENUE_PANEL = 'src/components/AppBlocks/RevenuePanel.tsx';
const EARNINGS_PANEL = 'src/components/Apps/AppEarningsPanel.tsx';
const EARNINGS_ROUTER = 'src/server/routers/app-collaborators.router.ts';
/** The REMOVED mint — was the only writer of `paidOutAt` / `payoutId`. */
const PAYOUT_MINT = 'mintPayoutForOwner';
/**
 * A real exported symbol from the module the mint used to live in, scanned with the SAME
 * machinery as the positive control for it. Without this, `PAYOUT_MINT`'s zero is
 * indistinguishable from a scan that matches nothing because the regex, the walk or the roots
 * are wrong.
 */
const PAYOUT_MINT_CONTROL = 'getRevenueForOwner';
/** The REMOVED weekly stub cron — neither the module nor the registration may come back. */
const PAYOUT_JOB_MODULE = 'src/server/jobs/bulk-payout-block-attributions.ts';
const PAYOUT_JOB_EXPORT = 'bulkPayoutBlockAttributions';
const RUN_JOBS = 'src/pages/api/webhooks/run-jobs/[[...run]].ts';
/** A block-attribution job that IS still registered — the run-jobs read's positive control. */
const RUN_JOBS_CONTROL = 'confirmPendingBlockAttributions';

function read(relPath: string) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

/**
 * `.ts`/`.tsx` only by default, which is what the COPY ledger below wants.
 *
 * 🔴 The mint ledger passes `CODE_FILES` instead, and the difference is the point: a
 * caller could live in a `.mjs` script or a Svelte component, and a guard whose headline
 * says "anywhere a caller could live" while walking `.tsx?` alone would stay green
 * through exactly that. It is not a rounding error: the roots hold hundreds of such
 * files — Svelte sources under both `packages/civitai-ui` and `apps/*`, JS under
 * `apps/*`, and `scripts/*.mjs`.
 */
function walk(dir: string, out: string[] = [], match = /\.tsx?$/): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out, match);
    else if (match.test(entry)) out.push(full);
  }
  return out;
}

/** Every extension a production caller of the mint could be written in. */
const CODE_FILES = /\.(tsx?|jsx?|mjs|cjs|svelte)$/;

const rel = (p: string) =>
  p
    .slice(REPO_ROOT.length + 1)
    .split('\\')
    .join('/');

/**
 * 🔴 WHERE STRIPPING IS AND IS NOT USED, because the choice is polarity-dependent.
 *
 * Stripping (via the shared `test/strip-comments` — not a local copy, since that module
 * exists precisely because the technique was re-derived at a second site and lost a case)
 * is used only where the assertion is about CODE SHAPE on a file pinned by name — today just
 * the earnings router / trpc gate reads at the bottom of this file.
 *
 * It is NOT used for the mint LEDGER or the job-registration read, which scan raw text. That
 * module documents itself as biased toward over-stripping because over-stripping "turns the
 * guard RED, which is the safe direction" — true for its other callers, which assert a call IS
 * present. For a guard asserting ABSENCE the same bias turns it GREEN, so the inherited
 * argument inverts. Those scans therefore never strip, and each carries a positive control
 * that the scan can find something at all. (Raw text is also what makes the mint ledger
 * strictly stronger here: a comment merely NAMING the removed mint fails it, which is the
 * right polarity — the point is that nothing in the tree points a reader at a rail that is
 * gone.)
 */

/**
 * Flatten a JSX fragment to the text a reader sees: `{' '}` separators become spaces, tags
 * drop (keeping their children, so an anchor's label survives), whitespace collapses. The
 * page's subtitle is a fragment with an embedded `<Anchor>`, so it has no single string
 * literal to assert against — this is what makes a whole-string pin possible at all.
 */
function jsxText(block: string) {
  return block
    .replace(/\{'\s*'\}/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Flatten a JSDoc block to its sentence text: drop the `*` leaders and collapse whitespace,
 * so a claim can be pinned WHOLE without the pin also encoding where prettier happened to
 * wrap the line. Same reasoning as `jsxText` — normalise the presentation, keep the words.
 */
function prose(block: string) {
  return block
    .replace(/^\s*\/\*\*|\*\/\s*$/g, '')
    .replace(/^[ \t]*\*[ \t]?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The balanced `{...}` value of a JSX prop, so the extraction cannot run past the prop. */
function propValue(src: string, prop: string) {
  const key = `${prop}={`;
  const start = src.indexOf(key);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start + key.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + key.length, i);
  }
  return null;
}

const SUBTITLE =
  'Revenue share and analytics for your apps. Confirmed earnings accrue here; ' +
  'automated payouts are not yet enabled. See Apps to manage installations.';

const CONFIRMED_TOOLTIP =
  'Past the refund window. This amount accrues; automated payouts are not yet enabled.';

describe('app earnings copy does not promise a payout pipeline that does not run', () => {
  it('sanity: every file this guard reasons about is on disk (positive control)', () => {
    // Without this, a renamed or moved file would make the assertions below pass by
    // reading an empty string / matching nothing, which is the shape of a vacuous green.
    for (const f of [REVENUE_PAGE, REVENUE_PANEL, EARNINGS_PANEL, EARNINGS_ROUTER]) {
      expect(read(f).length).toBeGreaterThan(0);
    }
  });

  it('the payout rail does not exist — zero references to the mint, with a positive control', () => {
    // 🔴 The STATE half, and the one that licenses the copy below. It is deliberately its
    // own test so it fails for its OWN reason: if it lived with the copy assertions, an
    // earlier string mismatch would throw first and this would never be evaluated.
    //
    // 🔴 THIS SCANS RAW TEXT, AND THAT IS THE WHOLE DESIGN. `test/strip-comments` documents
    // itself as biased toward over-stripping because over-stripping "turns the guard RED,
    // which is the safe direction" — true for its other callers, which assert a call IS
    // present. THIS guard asserts the opposite, so for it over-stripping turns the guard
    // GREEN: a real call the stripper ate would read as "no caller". The inherited safety
    // argument INVERTS here. (Measured: a `/*` inside a `//` comment, or a regex literal
    // ending `\/`, hides real code in ~105 files across these roots — including files under
    // services/blocks/, the payout rail's own neighbourhood.)
    //
    // Scanning raw text also makes this guard wider than "no caller": a COMMENT naming the
    // mint fails it too. That is the right polarity now the mint is deleted — the failure
    // mode being prevented is a reader being pointed at a rail that is gone, exactly the
    // class of defect this file exists for. ⚠️ Its reach is CODE under these roots —
    // `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.svelte`. PROSE is not scanned: `.md`,
    // `.prisma` and migration `.sql` do name the mint deliberately — the Prisma docstring
    // for the table it left behind, the GA handoff tracker, and the applied migrations,
    // which are a historical record and must not be rewritten.
    const files = CALLER_ROOTS.flatMap((d) => walk(join(REPO_ROOT, d), [], CODE_FILES));
    // 🔴 WALK POSITIVE CONTROLS — EXACT PATHS, one per root and one per extension class
    // that exists in the tree (`.cjs` by probe only; there are no `.jsx` files here). A
    // misrooted or empty walk finds no mentions either, and would read as "the rail does
    // not exist" no matter what the tree holds.
    //
    // 🔴 MEMBERSHIP IS EXACT, AND MUST STAY EXACT. A prefix test
    // (`f.startsWith(<root> + '/')`) degenerates to "this root is non-empty" and stays
    // GREEN when `CODE_FILES` narrows back to `/\.tsx?$/`, i.e. when the widening this
    // ledger depends on is undone.
    const walked = new Set(files.map(rel));
    expect(files.length).toBeGreaterThan(3000);
    for (const probe of [
      REVENUE_PANEL,
      'packages/civitai-db/src/kysely.ts',
      'packages/civitai-ui/src/lib/components/selection/selection-checkbox.svelte',
      'apps/training-studio/svelte.config.js',
      'scripts/typecheck.mjs',
      'scripts/graceful-fs-patch.cjs',
    ]) {
      expect(walked.has(probe)).toBe(true);
    }
    // ...and a count for the three non-`.tsx?` classes with enough files to floor, so
    // dropping one of those extensions from `CODE_FILES` fails even if its named probe is
    // later deleted. (`.ts`/`.tsx` are floored jointly by the `files.length` assertion.)
    const byExt = (re: RegExp) => files.filter((f) => re.test(f)).length;
    expect(byExt(/\.svelte$/)).toBeGreaterThan(400);
    expect(byExt(/\.mjs$/)).toBeGreaterThan(40);
    expect(byExt(/\.js$/)).toBeGreaterThan(100);

    const countOf = (needle: string) => {
      const re = new RegExp(String.raw`\b${needle}\b`, 'g');
      const mentions = new Map<string, number>();
      for (const f of files) {
        const r = rel(f);
        if (/\.(test|spec)\.[a-z]+$/.test(r) || r.includes('__tests__/')) continue;
        const n = (readFileSync(f, 'utf8').match(re) ?? []).length;
        if (n > 0) mentions.set(r, n);
      }
      return Object.fromEntries([...mentions].sort());
    };

    // 🔴 POSITIVE CONTROL ON THE ZERO. `PAYOUT_MINT_CONTROL` is a symbol that is genuinely
    // exported from the module the mint used to live in, counted by the SAME regex over the
    // SAME file list. Without it, `{}` below is indistinguishable from a scan wired to
    // nothing — a broken regex, a bad walk or a wrong `rel()` all produce the same clean
    // pass. Asserting the control's declaring file by NAME (not just "non-empty") is what
    // makes it a control for THIS scan rather than for any scan at all.
    const control = countOf(PAYOUT_MINT_CONTROL);
    expect(Object.keys(control)).toContain(
      'src/server/services/blocks/buzz-attribution.service.ts'
    );

    // 🔴 THE LEDGER, NOW EMPTY BY CONSTRUCTION. Fails the moment any non-test CODE file
    // under these roots names the mint again — a call, an import, an alias, a callback
    // reference, `.call`/`.apply`, a computed access, or a comment. The control above is
    // what turns this `{}` into evidence rather than a coincidence.
    expect(countOf(PAYOUT_MINT)).toEqual({});
  });

  it('the weekly payout stub cron is gone — no module and no registration', () => {
    // The second half of the removal. The job used to be registered and DID run; what made
    // the cadence copy false was that its body only read and logged. It has now been
    // deleted outright, so the check is structural: the module must not exist, and the
    // `jobs` array must not name it. Membership of that array plus a cron string IS the
    // registration on this deployment — see CLAUDE.md, "How a scheduled job actually gets
    // scheduled" — so the array is the authoritative place to assert the absence.
    expect(existsSync(join(REPO_ROOT, PAYOUT_JOB_MODULE))).toBe(false);

    const runJobs = read(RUN_JOBS);
    // 🔴 POSITIVE CONTROL, TWICE OVER. A zero from a file that failed to load, or whose job
    // array this guard can no longer find, is indistinguishable from a real absence. So:
    // the file is non-trivial, and a SIBLING block-attribution job that IS still registered
    // must be found by the same read. If that control ever fails, this test is measuring
    // nothing and the absence below means nothing.
    expect(runJobs.length).toBeGreaterThan(1000);
    expect(runJobs).toContain(RUN_JOBS_CONTROL);

    // Both spellings: the module path (an import) and the exported job (the array entry).
    // Raw text on purpose — a commented-out registration is still a thing to delete, and a
    // future reader should not find a half-restored wiring instruction here.
    expect(runJobs).not.toContain(PAYOUT_JOB_MODULE.replace(/^src\//, '~/').replace(/\.ts$/, ''));
    expect(runJobs).not.toContain(PAYOUT_JOB_EXPORT);
  });

  it('/apps/revenue subtitle states accrual, pinned whole', () => {
    const subtitle = propValue(read(REVENUE_PAGE), 'subtitle');
    expect(subtitle).not.toBeNull();
    expect(jsxText(subtitle!)).toBe(SUBTITLE);
  });

  it('the Confirmed (unpaid) tooltip states accrual, pinned whole', () => {
    const panel = read(REVENUE_PANEL);
    // Anchored to the card it annotates, so the assertion cannot be satisfied by the string
    // appearing anywhere else in the file.
    const at = panel.indexOf('Confirmed (unpaid)');
    // Without this the anchor's absence gives `slice(-1)` — one character — and the failure
    // reads as a copy mismatch rather than "the card this guard targets is gone".
    expect(at).toBeGreaterThan(-1);
    const label = /label="([^"]*)"/.exec(panel.slice(at))?.[1];
    expect(label).toBe(CONFIRMED_TOOLTIP);
  });

  it('the earnings docblock describes the gate the proc actually has', () => {
    // 🔴 STATE, not vocabulary: the defect was a comment asserting an access property the
    // code does not have. Pinning the procedure name on both sides is what ties them — if
    // someone widens the proc to `protectedProcedure`, this fails and the docblock (and the
    // invite disclosure's scope) must be re-read rather than silently becoming true.
    const router = stripComments(read(EARNINGS_ROUTER));
    expect(router).toMatch(/getAppEarnings:\s*appDeveloperProcedure/);
    // The gate the docblock describes must be the gate the middleware implements. Reading
    // trpc.ts here is what stops `appDeveloperProcedure` from being a name the docblock and
    // the router merely agree on while it quietly stops refusing anyone.
    const trpc = stripComments(read('src/server/trpc.ts'));
    expect(trpc).toMatch(
      /appDeveloperProcedure\s*=\s*protectedProcedure\.use\(hasAppBlocksAuthor\)/
    );
    expect(trpc).toMatch(/hasAppBlocksAuthor[\s\S]{0,400}FORBIDDEN/);
    // ...and the docblock must CARRY THE CORRECTION, pinned whole like the two copy strings.
    // Deliberately NOT a negative grep for the retracted sentence: the rewrite QUOTES that
    // sentence so the next reader knows what was wrong, so a "must not contain" test would
    // forbid the clearest way to document the correction. But two bare `toMatch` identifier
    // probes would be weaker than this test's NAME claims — a docblock re-asserting the
    // retracted claim while still naming both identifiers would pass. Pinning the sentence
    // is what makes the name true.
    const docblock = read(EARNINGS_PANEL).slice(0, read(EARNINGS_PANEL).indexOf('function '));
    expect(docblock.length).toBeGreaterThan(0); // anchor control
    const CORRECTION =
      'so it throws FORBIDDEN for any caller outside the `appBlocksAuthor` cohort, ' +
      'accepted editor or not.';
    expect(prose(docblock)).toContain(CORRECTION);
    // The disclosure must not be quietly narrowed to today's gate: the reason it stays wide
    // is that the cohort is a runtime flag, and that reason has to survive in the file.
    expect(prose(docblock)).toContain('DO NOT SOFTEN THE DISCLOSURE TO MATCH THAT GATE.');
  });

  it('GROW half: the set of surfaces rendering settlement buckets is a known ledger', () => {
    // 🔴 The SHRINK half is the two whole-string pins above — they fail if either sentence is
    // reworded. This is the other direction: nothing fails when a THIRD money surface appears
    // on a file nobody listed, which is the condition that let one wrong claim become three.
    //
    // 🔴 DELIBERATELY A STRUCTURAL LEDGER, NOT A CADENCE-PHRASE SCAN. A phrase scan was
    // written first and MEASURED before being discarded: ten realistic re-promises evaded it
    // ("Payouts run weekly", "disbursed every Monday", "Funds are transferred weekly",
    // "You get paid every week"), while six TRUE statements tripped it — including
    // "Payouts are processed manually until the automated rail lands" and anything using
    // "will be paid". It also read raw text, so a comment quoting the retracted sentence as
    // documentation would have failed the build, which is the unlandable-guard shape that
    // gets a guard deleted rather than obeyed. English cadence is not a regex problem.
    //
    // What IS checkable is the population. These two bucket labels are the settlement
    // vocabulary, and this PR's scope deliberately keeps them stable, so they are a reliable
    // marker for "this file shows a user money that may or may not have been disbursed".
    // A third such surface fails here, and its author then has to decide — consciously —
    // whether it needs the accrual disclosure the other two carry.
    const BUCKET_LABELS = ['Confirmed (unpaid)', 'Paid out'];
    const files = MONEY_COPY_ROOTS.flatMap((d) => walk(join(REPO_ROOT, d)));
    // Walk positive control: an empty walk yields an empty set, which would "equal" nothing
    // and pass if the expectation below were also empty. It is not — but prove the walk ran.
    expect(files.length).toBeGreaterThan(50);
    expect(files.map(rel)).toContain(REVENUE_PANEL);

    const surfaces = files
      .filter((f) => !/\.test\.tsx?$/.test(rel(f)) && !rel(f).includes('__tests__/'))
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return BUCKET_LABELS.every((l) => src.includes(l));
      })
      .map(rel)
      .sort();

    // Non-empty by construction, so this cannot be a vacuous "no matches" pass.
    expect(surfaces).toEqual([EARNINGS_PANEL, REVENUE_PANEL].sort());
  });
});
