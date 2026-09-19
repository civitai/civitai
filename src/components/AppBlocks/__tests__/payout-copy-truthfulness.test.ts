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
 *   GROW — a cadence PHRASE scan over the money surfaces, so a THIRD such sentence on a
 *   file nobody listed also fails. The SHRINK half only ever knew about files it was told
 *   about by name, and being told about two of three is how this shipped.
 *
 *   STATE — the copy is only true while the rail is unwired and the job writes nothing, so
 *   both are asserted directly rather than trusted.
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
 * STILL NOT COVERED, stated rather than implied: a renaming import
 * (`import { mintPayoutForOwner as mint }`) and a computed member access. Closing those
 * needs a type-aware pass, which is a bigger thing than the defect — and the realistic
 * wiring point is the job named in this file, which the identifier scan does see.
 */
const CALLER_ROOTS = ['src', 'packages', 'apps', 'scripts'];

/**
 * The user-facing surfaces that render App Blocks money. This is the ledger's GROW half:
 * a new payout-cadence sentence anywhere in these trees fails, not just a reword of the
 * two strings pinned below. Without it the guard only ever knew about files it was told
 * about by name, which is the condition that let one wrong sentence become three.
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
 * 🔴 Comments AND strings come out before any structural scan, via the shared
 * `test/strip-comments` module rather than a local copy — that module exists precisely
 * because this technique was re-derived at a second site and lost a case. Both hazards
 * are live here:
 *
 *   - COMMENTS: the payout job's header contains the literal
 *     `mintPayoutForOwner({ appOwnerUserId, periodKey })` as the instruction for wiring it
 *     later. It is call-SHAPED, so without stripping, "the rail is wired" would be
 *     permanently — and wrongly — true.
 *   - STRINGS: a name inside a string literal is never a call either, and that is the
 *     false positive one syntax over.
 *
 * The shared helper is also biased toward over-stripping, which turns a miss RED rather
 * than silently green — the safe direction, and why each scan below carries a positive
 * control that the thing being counted was actually found.
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

  it('the payout rail is still unwired — no production caller mints a payout', () => {
    // 🔴 The STATE half, and the one that licenses the copy below. It is deliberately its
    // own test so it fails for its OWN reason: if it lived with the copy assertions, an
    // earlier string mismatch would throw first and this would never be evaluated.
    const files = CALLER_ROOTS.flatMap((d) => walk(join(REPO_ROOT, d)));
    // Tree-walk positive control: an empty or misrooted walk finds no callers either, and
    // would read as "the rail is unwired" no matter what the tree contains.
    expect(files.length).toBeGreaterThan(3000);
    expect(files.map(rel)).toContain(REVENUE_PANEL);

    const declarations: string[] = [];
    const callers: string[] = [];
    const re = new RegExp(String.raw`(function\s+)?\b${PAYOUT_MINT}\b\s*[({]`, 'g');
    for (const f of files) {
      const r = rel(f);
      if (/\.test\.tsx?$/.test(r) || r.includes('__tests__/')) continue;
      const code = stripCommentsAndStrings(readFileSync(f, 'utf8'));
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) (m[1] ? declarations : callers).push(r);
    }

    // Positive control on the scan itself: the mint must be FOUND, or "no callers" is just
    // a regex that matches nothing — indistinguishable from a probe wired to nothing.
    expect(declarations).toEqual(['src/server/services/blocks/buzz-attribution.service.ts']);
    // If this fails, the payout rail has a caller. The accrual copy pinned below is then
    // stale in the opposite direction and must be revisited.
    expect(callers).toEqual([]);
  });

  it('the weekly job still writes nothing', () => {
    // The job IS registered and DOES run, so "the cron is off" is not why the cadence copy
    // was false. What makes it false is that the run body only reads and logs — asserted
    // here rather than inferred from the header comment, which is itself prose.
    const job = stripCommentsAndStrings(read('src/server/jobs/bulk-payout-block-attributions.ts'));
    // Positive control: the read path must be FOUND, or every "no write" assertion below is
    // just a regex matching nothing over a file that failed to load.
    expect(job).toMatch(/dbRead\./);
    expect(job).not.toMatch(/\bdbWrite\b/);
    expect(job).not.toMatch(
      /\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\s*\(/
    );
    // Raw-SQL escape hatches, which the Prisma-method list above cannot see.
    expect(job).not.toMatch(/\$execute(Raw|RawUnsafe)|\$queryRaw(Unsafe)?/);
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
    const card = panel.slice(panel.indexOf('Confirmed (unpaid)'));
    const label = /label="([^"]*)"/.exec(card)?.[1];
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
    // ...and the docblock must name it. Deliberately NOT a negative grep for the retracted
    // sentence: the rewrite QUOTES that sentence so the next reader knows what was wrong, so
    // a "must not contain" test would forbid the clearest way to document the correction.
    expect(read(EARNINGS_PANEL)).toMatch(/appDeveloperProcedure/);
    expect(read(EARNINGS_PANEL)).toMatch(/appBlocksAuthor/);
  });

  it('GROW half: no surface promises a payout CADENCE', () => {
    // 🔴 The SHRINK half is the two whole-string pins above — they fail if either sentence
    // is reworded. This is the other direction: nothing fails when a THIRD cadence sentence
    // appears on a surface nobody listed, which is exactly how one wrong claim became three.
    // A phrase scan is walkable in a way the whole-string pins are not; it is the cheap
    // complement to them, not a replacement, and it is scoped to the money surfaces.
    const CADENCE =
      /next payout|batched\s+(weekly|daily|monthly)|paid out\s+(weekly|daily|monthly)|payouts?\s+are\s+(batched|sent|issued|processed)|will be (included in|paid)/i;

    // Positive control: the regex must catch the two sentences this PR removed. Without it a
    // typo in the pattern yields a clean sweep that measured nothing.
    expect('Payouts are batched weekly; see').toMatch(CADENCE);
    expect('Will be included in your next payout.').toMatch(CADENCE);
    // Negative control: the legitimate bucket labels and the new accrual copy must NOT trip
    // it, or the guard is unlandable and gets deleted rather than obeyed.
    expect('Refunds, chargebacks, and self-purchases. Not paid out.').not.toMatch(CADENCE);
    expect(CONFIRMED_TOOLTIP).not.toMatch(CADENCE);
    expect(SUBTITLE).not.toMatch(CADENCE);

    const files = MONEY_COPY_ROOTS.flatMap((d) => walk(join(REPO_ROOT, d)));
    expect(files.length).toBeGreaterThan(50); // walk positive control

    const offenders = files
      .filter((f) => !/\.test\.tsx?$/.test(rel(f)) && !rel(f).includes('__tests__/'))
      .filter((f) => CADENCE.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort();
    // If this fails, a new sentence promises a disbursement schedule. Either the rail is now
    // wired (the state guard above should have failed first), or the sentence is untrue.
    expect(offenders).toEqual([]);
  });
});
