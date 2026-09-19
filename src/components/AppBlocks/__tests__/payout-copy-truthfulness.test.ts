import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { stripComments, stripCommentsAndStrings } from '../../../../test/strip-comments';

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
 * `mintPayoutForOwner` is the ONLY writer of `paidOutAt`/`payoutId` and has no production
 * caller; the weekly `bulk-payout-block-attributions` job is registered and does run, but
 * aggregates, logs to Axiom and writes nothing. So the cadence was invented, and the copy
 * was the only place it existed.
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
 * If you are here because you WIRED the payout rail: the `payout rail is still unwired`
 * guard is the one that should have failed first. Both copy strings may then legitimately
 * promise a cadence again — update them and this file together, in that order.
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
/** The only writer of `paidOutAt` / `payoutId`. */
const PAYOUT_MINT = 'mintPayoutForOwner';

function read(relPath: string) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

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
 * is used only for assertions of the form "this code is NOT here", on files already pinned
 * by name: the two prose mentions of the mint, and the payout job's write scan. There,
 * dropping comments is what stops the job header's call-SHAPED wiring instruction from
 * reading as a live call.
 *
 * It is NOT used for the mint LEDGER, which scans raw text. That module documents itself as
 * biased toward over-stripping because over-stripping "turns the guard RED, which is the
 * safe direction" — true for its other callers, which assert a call IS present. For a guard
 * asserting ABSENCE the same bias turns it GREEN, so the inherited argument inverts. The
 * ledger therefore never strips, and each scan carries a positive control that what it
 * counts was actually found.
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

  it('the payout rail is still unwired — an exact ledger of every mention of the mint', () => {
    // 🔴 The STATE half, and the one that licenses the copy below. It is deliberately its
    // own test so it fails for its OWN reason: if it lived with the copy assertions, an
    // earlier string mismatch would throw first and this would never be evaluated.
    //
    // 🔴 THIS SCANS RAW TEXT, AND THAT IS THE WHOLE DESIGN. `test/strip-comments` documents
    // itself as biased toward over-stripping because that "turns the guard RED, which is the
    // safe direction" — true for its other callers, which assert a call IS present. THIS
    // guard asserts the opposite, so for it over-stripping turns the guard GREEN: a real call
    // the stripper ate would read as "no caller". The inherited safety argument INVERTS here.
    // (Measured: a `/*` inside a `//` comment, or a regex literal ending `\/`, hides real
    // code in ~105 files across these roots — including files under services/blocks/, the
    // payout rail's own neighbourhood.)
    //
    // So the ledger is built from untouched file text and pins an exact OCCURRENCE COUNT per
    // file. Any new reference — a call, an import, an alias, a bare callback reference,
    // `.call`/`.apply`, a computed access — changes a count or adds a file, and fails. That
    // is strictly stronger than a call-shaped regex over stripped text, and it has no blind
    // spot to disclose.
    const files = CALLER_ROOTS.flatMap((d) => walk(join(REPO_ROOT, d)));
    // Walk positive controls, one per root: a misrooted or empty walk finds no mentions
    // either, and would read as "the rail is unwired" no matter what the tree holds. The
    // total alone cannot see a dropped root — `src` by itself clears any plausible threshold.
    expect(files.length).toBeGreaterThan(3000);
    for (const probe of [
      REVENUE_PANEL,
      'packages/civitai-db/src/kysely.ts',
      'apps/moderator/svelte.config.js.d.ts',
      'scripts/typecheck.mjs',
    ]) {
      expect(
        files.map(rel).some((f) => f === probe || f.startsWith(probe.split('/')[0] + '/'))
      ).toBe(true);
    }

    const mentions = new Map<string, number>();
    const ident = new RegExp(String.raw`\b${PAYOUT_MINT}\b`, 'g');
    for (const f of files) {
      const r = rel(f);
      if (/\.test\.tsx?$/.test(r) || r.includes('__tests__/')) continue;
      const n = (readFileSync(f, 'utf8').match(ident) ?? []).length;
      if (n > 0) mentions.set(r, n);
    }

    // 🔴 THE LEDGER. Fails when the set GROWS (a new file references the mint) or SHRINKS
    // (a listed mention disappears, so this ledger is stale and its counts mean nothing).
    // The declaration's own file is the positive control: if the scan is wired to nothing,
    // this entry vanishes and the assertion fails rather than passing clean.
    expect(Object.fromEntries([...mentions].sort())).toEqual({
      // The declaration itself — the only writer of `paidOutAt`/`payoutId`.
      'src/server/services/blocks/buzz-attribution.service.ts': 1,
      // Prose only: the header's design note, incl. a call-SHAPED wiring instruction.
      'src/server/jobs/bulk-payout-block-attributions.ts': 3,
      // Prose only: a comment about the `(app_owner_user_id, period_key)` UNIQUE.
      'src/server/services/blocks/app-ownership-transfer.service.ts': 1,
    });

    // ...and the two prose entries must still be PROSE. Counts alone cannot tell a comment
    // from code, so this is the half that says the mentions are not calls. Over-stripping
    // can only make this assertion pass more easily, which is why it is a secondary check
    // behind the raw ledger rather than the guard itself.
    for (const f of [
      'src/server/jobs/bulk-payout-block-attributions.ts',
      'src/server/services/blocks/app-ownership-transfer.service.ts',
    ]) {
      expect(stripCommentsAndStrings(read(f))).not.toMatch(ident);
    }
  });

  it('the weekly job still writes nothing', () => {
    // The job IS registered and DOES run, so "the cron is off" is not why the cadence copy
    // was false. What makes it false is that the run body only reads and logs — asserted
    // here rather than inferred from the header comment, which is itself prose.
    // Every write idiom this repo's jobs actually use — Prisma, the `pgDb*` raw clients and
    // the Kysely builder. `\bdbWrite\b` alone does NOT cover `pgDbWrite`, and `.update(` does
    // NOT cover Kysely's `.updateTable(`; both shapes are live in other job files.
    const WRITE_IDIOMS = [
      /\b(db|pgDb|kyselyDb)Write\b/,
      /\.(update|updateMany|create|createMany|upsert|delete|deleteMany|updateTable|insertInto|deleteFrom)\s*\(/,
      /\$execute(Raw|RawUnsafe)|\$queryRaw(Unsafe)?/,
    ];
    // 🔴 POSITIVE CONTROL ON THE NEGATIVES. A `not.toMatch` that CANNOT fire is
    // indistinguishable from one that found nothing, so each pattern is first shown to match
    // a synthetic line it must catch. Without this a typo'd pattern reports the job clean.
    const MUST_CATCH = [
      'await pgDbWrite.query("UPDATE x SET y")',
      'await kyselyDb.updateTable("t").set({ a: 1 }).execute()',
      'await dbWrite.$executeRawUnsafe(sql)',
    ];
    for (const sample of MUST_CATCH) {
      expect(WRITE_IDIOMS.some((re) => re.test(sample))).toBe(true);
    }

    const job = stripCommentsAndStrings(read('src/server/jobs/bulk-payout-block-attributions.ts'));
    // Positive control: the read path must be FOUND, or every "no write" assertion below is
    // just a regex matching nothing over a file that failed to load.
    expect(job).toMatch(/dbRead\./);
    for (const re of WRITE_IDIOMS) expect(job).not.toMatch(re);

    // 🔴 AND NO INDIRECTION. The idiom list above cannot see `await flipRowsToPaidOut(rows)`
    // — a helper whose body does the write. The job's whole run body is small and its only
    // awaited calls are the read and the log, so pin THAT rather than trusting the list to
    // be exhaustive: any new awaited call here is a write candidate and must be looked at.
    const awaited = [...job.matchAll(/await\s+([A-Za-z_$][\w$.]*)\s*\(/g)].map((m) => m[1]).sort();
    expect(awaited).toEqual(['dbRead.blockBuzzAttribution.groupBy']);
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
