import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Money copy must not describe a disbursement that does not run.
 *
 * Three user-visible strings asserted an automated payout pipeline — "Payouts are batched
 * weekly", "Will be included in your next payout", and a docblock claiming the earnings
 * proc "grants it to any accepted editor with a session". None of the three was true, and
 * all three were reachable by the `appBlocksAuthor` cohort: the Earnings tab is one click
 * from the default tab on the listing editor, and /apps/revenue is linked from Apps.
 *
 * Nothing could have caught them, because each was prose agreeing only with other prose.
 * `mintPayoutForOwner` is the ONLY writer of `paidOutAt`/`payoutId` and has no production
 * caller; the weekly `bulk-payout-block-attributions` job is registered and does run, but
 * aggregates, logs to Axiom and writes nothing. So the cadence was invented, and the copy
 * was the only place it existed.
 *
 * 🔴 THIS PINS WHOLE NORMALISED STRINGS, DELIBERATELY. A guard that greps for a banned word
 * ("payout", "weekly") is walked by rewording, which on a money surface is the exact failure
 * mode — the next sentence promising a cadence will not reuse this sentence's vocabulary.
 * The cost is that a cosmetic reword goes red for a non-defect. Pay it: re-reading the two
 * state guards below is the point, and it is what makes the claim machine-readable rather
 * than a sentence asking the next author to remember.
 *
 * If you are here because you WIRED the payout rail: the `payout rail is still unwired`
 * guard is the one that should have failed first. Both copy strings may then legitimately
 * promise a cadence again — update them and this file together, in that order.
 */

const REPO_ROOT = join(__dirname, '../../../..');
const SRC = join(REPO_ROOT, 'src');

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
 * Comments are stripped before any caller scan. Without this the guard reads its own
 * documentation as a caller: the job file's header contains the literal
 * `mintPayoutForOwner({ appOwnerUserId, periodKey })` as the instruction for wiring it
 * later, which is call-SHAPED and would make "the rail is wired" permanently true.
 */
function stripComments(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

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
    const files = walk(SRC);
    // Tree-walk positive control: an empty or misrooted walk finds no callers either, and
    // would read as "the rail is unwired" no matter what the tree contains.
    expect(files.length).toBeGreaterThan(3000);
    expect(files.map(rel)).toContain(REVENUE_PANEL);

    const declarations: string[] = [];
    const callers: string[] = [];
    for (const f of files) {
      const r = rel(f);
      if (/\.test\.tsx?$/.test(r) || r.includes('__tests__/')) continue;
      const code = stripComments(readFileSync(f, 'utf8'));
      const re = new RegExp(String.raw`(function\s+)?\b${PAYOUT_MINT}\b\s*[({]`, 'g');
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
    const job = stripComments(read('src/server/jobs/bulk-payout-block-attributions.ts'));
    expect(job).toMatch(/dbRead\./);
    expect(job).not.toMatch(/\bdbWrite\b/);
    expect(job).not.toMatch(/\.(update|updateMany|create|createMany|upsert)\s*\(/);
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
    expect(stripComments(read(EARNINGS_ROUTER))).toMatch(/getAppEarnings:\s*appDeveloperProcedure/);
    expect(read(EARNINGS_PANEL)).toMatch(/appDeveloperProcedure/);
    // The retracted claim: the proc does NOT grant earnings to any accepted editor with a
    // session — it throws FORBIDDEN outside the `appBlocksAuthor` cohort.
    expect(read(EARNINGS_PANEL)).not.toMatch(/grants it to any\s*\n?\s*\*?\s*accepted editor/);
  });
});
