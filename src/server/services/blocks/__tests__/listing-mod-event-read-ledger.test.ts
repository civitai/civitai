import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { LISTING_STATUS_CHANGING_MODERATION_ACTIONS } from '~/server/services/blocks/app-listing-owner-unpublish';

/**
 * 🔴 A LEDGER OF EVERY READ OF `AppListingModerationEvent`, AND WHAT EACH ONE ASKS.
 *
 * WHY THIS EXISTS. "Which moderation event explains why this listing is `removed`?" is
 * answered by the MOST-RECENT event whose action actually WRITES `app_listings.status`.
 * `LISTING_STATUS_CHANGING_MODERATION_ACTIONS` is that set, and it is supposed to have ONE
 * spelling. It did not: the predicate was open-coded, and each round of review found
 * another copy — SIX read sites by the time anyone counted, two of them unfiltered, one of
 * those in raw SQL where no behavioural test could see it. Every unfiltered copy fails the
 * same way and in the same direction: a moderator's `message-owner` ("fix X and republish"),
 * a `claim`, or a `report-resolve` is newer than the owner's own `owner-unpublish`, so the
 * page tells the owner a moderator removed a listing the server would happily republish.
 *
 * 🔴 THIS PINS A RELATIONSHIP, NOT A COMPONENT — which is the point. Each of those six sites
 * was individually reviewed and individually tested; the defect lived in the SEAM, in the
 * fact that nobody owned the SET of readers. So this asserts the whole set: it fails when a
 * SEVENTH read appears (an unclassified reader) AND when one disappears (a stale ledger
 * entry, the direction allowlists routinely get wrong).
 *
 * 🔴 IT IS STRUCTURAL, SO IT IS NOT SUFFICIENT ON ITS OWN. It proves each `filtered` reader
 * MENTIONS the constant near its read; it cannot prove the mention is wired correctly — a
 * structural check type-checks straight past a wrong argument. The behavioural half lives
 * with each reader (`app-listing-owner-unpublish.test.ts`,
 * `blocks.router.listMyPublishRequests.test.ts`, `app-access.my-app-listings-moderation
 * .test.ts`, and the whole-SQL-text pin in `offsite-listing.edit.service.test.ts`). Both
 * halves are needed; neither replaces the other.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

/** A Prisma read, or the raw-SQL read, of the moderation-event table. */
const READ_PATTERNS = [
  /appListingModerationEvent\s*\.\s*(?:findFirst|findMany|findUnique|findUniqueOrThrow|findFirstOrThrow|aggregate|groupBy)\b/g,
  /\bFROM\s+app_listing_moderation_events\b/g,
];

/**
 * Strip comments before ANY proximity check.
 *
 * 🔴 LOAD-BEARING. Every filtered read below is documented with a comment naming the
 * constant. Without this, the "the constant appears near the read" assertion is satisfied by
 * the PROSE, and deleting the actual `action: { in: … }` clause would leave the guard green
 * — the exact "a word another feature can spell" failure. Verified by the negative controls
 * at the bottom: a file whose ONLY mention is in a comment is reported as unfiltered.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Lines (1-based) in `src` at which a moderation-event read appears. */
function readLines(src: string): number[] {
  const lines: number[] = [];
  for (const re of READ_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) lines.push(src.slice(0, m.index).split('\n').length);
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

/**
 * Does a read at `line` carry the shared constant within the statement around it?
 *
 * A window rather than an exact parse: the constant is spread into a `where` (Prisma) or a
 * `Prisma.join` (raw SQL) a handful of lines from the call, and a paren-balancing extractor
 * is the fragile thing this deliberately avoids.
 */
const WINDOW = 14;
function readIsFiltered(strippedLines: string[], line: number): boolean {
  const window = strippedLines.slice(Math.max(0, line - 1 - 2), line - 1 + WINDOW).join('\n');
  return window.includes('LISTING_STATUS_CHANGING_MODERATION_ACTIONS');
}

type Kind = 'filtered' | 'full-timeline';

/**
 * 🔴 THE LEDGER. Every non-test read of `AppListingModerationEvent` in the repo, and what
 * question it asks. Adding a reader means adding a line here and stating which it is.
 *
 * `filtered`      — asks "what explains this removal?"; MUST restrict to
 *                   `LISTING_STATUS_CHANGING_MODERATION_ACTIONS`.
 * `full-timeline` — renders the audit history; deliberately reads EVERY action, because a
 *                   `message-owner` is precisely what the owner is meant to see there.
 */
const LEDGER: Record<string, { kind: Kind; why: string }> = {
  'src/server/services/blocks/app-listing-owner-unpublish.ts': {
    kind: 'filtered',
    why: 'readLastModerationAction — the canonical predicate every other filtered reader defers to.',
  },
  'src/server/services/blocks/app-access.service.ts': {
    kind: 'filtered',
    why: 'listMyAppListings — batched last-action per removed listing, drives the Republish affordance on /apps/mine.',
  },
  'src/server/routers/blocks.router.ts': {
    kind: 'filtered',
    why: 'listMyPublishRequests — same affordance for on-site apps. Was UNFILTERED (the sixth copy).',
  },
  'src/server/services/blocks/offsite-listing.service.ts': {
    kind: 'filtered',
    why: 'listMySubmissions — raw DISTINCT ON, the off-site my-submissions page. Was UNFILTERED (the seventh copy).',
  },
  'src/server/services/blocks/offsite-moderation.service.ts': {
    kind: 'full-timeline',
    why: 'queryModerationEvents — the paginated per-listing audit history (owner- and mod-scoped). Reads every action ON PURPOSE.',
  },
};

function scan() {
  const found: Record<string, number[]> = {};
  const stripped: Record<string, string[]> = {};
  for (const rel of globSync('src/**/*.{ts,tsx}', { cwd: REPO_ROOT })) {
    const file = rel.replace(/\\/g, '/');
    if (file.includes('/__tests__/') || /\.test\.tsx?$/.test(file)) continue;
    const abs = path.join(REPO_ROOT, rel);
    if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) continue;
    const src = readFileSync(abs, 'utf8');
    const s = stripComments(src);
    const lines = readLines(s);
    if (lines.length) {
      found[file] = lines;
      stripped[file] = s.split('\n');
    }
  }
  return { found, stripped };
}

describe('AppListingModerationEvent read ledger', () => {
  const { found, stripped } = scan();

  it('POSITIVE CONTROL: the scanner actually finds reads (a zero here would pass everything)', () => {
    // A detector wired to nothing reports a clean repo. This is the number that must move.
    expect(Object.keys(found).length).toBeGreaterThanOrEqual(5);
    expect(Object.values(found).flat().length).toBeGreaterThanOrEqual(5);
  });

  it('🔴 the set of readers is EXACTLY the ledger — fails when it grows AND when it shrinks', () => {
    expect(Object.keys(found).sort()).toEqual(Object.keys(LEDGER).sort());
  });

  it.each(
    Object.entries(LEDGER)
      .filter(([, v]) => v.kind === 'filtered')
      .map(([f]) => f)
  )('🔴 %s restricts to the SHARED constant at every read', (file) => {
    const lines = found[file] ?? [];
    expect(lines.length).toBeGreaterThan(0);
    const unfiltered = lines.filter((l) => !readIsFiltered(stripped[file], l));
    expect(unfiltered).toEqual([]);
  });

  it('the full-timeline reader is deliberately NOT filtered — stated, not assumed', () => {
    const file = 'src/server/services/blocks/offsite-moderation.service.ts';
    const lines = found[file] ?? [];
    expect(lines.length).toBeGreaterThan(0);
    // If this ever starts filtering, the audit history silently stops showing the owner the
    // moderator's message — a real regression that would otherwise look like a tightening.
    expect(lines.every((l) => !readIsFiltered(stripped[file], l))).toBe(true);
  });
});

/**
 * NEGATIVE CONTROLS on the detector itself. Until each of these has been watched to work,
 * the ledger above is a claim about the instrument, not about the repo.
 */
describe('the detector can go red', () => {
  it('finds a planted Prisma read', () => {
    expect(readLines('await dbRead.appListingModerationEvent.findMany({ where: {} });')).toEqual([
      1,
    ]);
  });

  it('finds a planted raw-SQL read', () => {
    expect(readLines('SELECT action\nFROM app_listing_moderation_events\nWHERE x')).toEqual([2]);
  });

  it('🔴 a mention in a COMMENT does not count as a filter', () => {
    const src = stripComments(
      [
        '// filtered to LISTING_STATUS_CHANGING_MODERATION_ACTIONS, honest',
        '/* also LISTING_STATUS_CHANGING_MODERATION_ACTIONS */',
        'await dbRead.appListingModerationEvent.findMany({ where: { appListingId } });',
      ].join('\n')
    ).split('\n');
    // The read is on the LAST line; both mentions are above it and both are comments.
    expect(readIsFiltered(src, 3)).toBe(false);
  });

  it('a real filter near the read DOES count', () => {
    const src = stripComments(
      [
        'await dbRead.appListingModerationEvent.findMany({',
        '  where: { action: { in: [...LISTING_STATUS_CHANGING_MODERATION_ACTIONS] } },',
        '});',
      ].join('\n')
    ).split('\n');
    expect(readIsFiltered(src, 1)).toBe(true);
  });

  it('the constant it names is the real exported one, not a string that merely looks like it', () => {
    expect(LISTING_STATUS_CHANGING_MODERATION_ACTIONS.length).toBeGreaterThan(0);
  });
});
