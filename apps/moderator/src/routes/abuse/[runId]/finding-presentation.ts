import { num } from '$lib/format';
import type { GroupableFinding } from '$lib/abuse-decisions';
import type { AbuseVerdict } from '$lib/abuse-verdicts';

/**
 * The run page's text, as plain functions.
 *
 * 🔴 IN A SIBLING MODULE FOR THE REASON `$lib/abuse-decisions.ts` GIVES: this app has no component
 * render harness, so a string composed inside a template is a string nothing can assert. Every
 * sentence here has a separator or a plural in it, and both of those are exactly what a template
 * silently gets wrong — Svelte trims the whitespace at the edges of a block, so a space typed at the
 * start of an `{#if}` is deleted and the words run together on the page while the source still
 * reads correctly.
 */

/** The finding fields the board RENDERS, on top of the ones it groups by. Structural, so the page's
 *  row type satisfies it without this module knowing where that type came from. */
export type RenderableFinding = GroupableFinding & {
  userId: number;
  reason: string;
  action: string | null;
  verdictBy: string | null;
  verdictAt: Date | null;
};

/** What a moderator is being asked, in their words rather than the detector author's. */
export const VERDICT_LABEL: Record<AbuseVerdict, string> = {
  tp: 'Correct',
  fp: 'False positive',
  skip: 'Skip',
};

/**
 * Rendered as visible text under each button — NOT as a `title` tooltip.
 *
 * "TP" is jargon for the person who wrote the detector and nothing at all for the moderator being
 * asked to rule, so the expansion has to be readable without discovering that hovering does
 * something. A tooltip also never appears in a screenshot, which is how this team reports.
 */
export const VERDICT_HINT: Record<AbuseVerdict, string> = {
  tp: 'The detector was right about this account.',
  fp: 'The detector was wrong — this account is fine.',
  skip: 'Looked at it; not calling it either way.',
};

/**
 * The per-verdict palette, beside the labels and hints it dresses rather than inside the component.
 *
 * 🔴 THE CHOSEN VERDICT IS FILLED, NOT TINTED. It used to be a transparent button behind a
 * fractional-opacity neutral wash — against this page's near-black panel, a lightness step of about
 * 0.03. Invisible in a row of three, so a moderator could not tell a ruled finding from an unruled
 * one without reading the line above it. `aria-pressed` carried the state correctly the whole time;
 * only the eye was unserved.
 *
 * 🔴 `bg-teal-700` AND `bg-rose-600` ARE FLOORS, NOT PREFERENCES. Measured against white: teal-700 is
 * 5.43:1 and rose-600 is 4.66:1, while the `teal-600` / `rose-500` this app reaches for elsewhere in
 * a filled selected state are 3.71:1 and 3.64:1 — both below AA for normal text. Do not harmonise
 * these down to match the other screens.
 *
 * 🔴 EVERY STATE NEEDS A HOVER, THE CHOSEN ONE INCLUDED. Re-ruling is supported and overwrites, so
 * the filled button is clickable; with its two neighbours lighting up and it not, it reads as
 * disabled — and that misreading arrived WITH the fill, because nothing was distinguishable enough
 * to notice before.
 */
export const VERDICT_CLASS: Record<AbuseVerdict, { idle: string; chosen: string }> = {
  tp: {
    idle: 'border-rose-500/40 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300',
    chosen: 'border-rose-400 bg-rose-600 text-white hover:bg-rose-500',
  },
  fp: {
    idle: 'border-teal-600/40 text-teal-400 hover:bg-teal-500/10 hover:text-teal-300',
    chosen: 'border-teal-400 bg-teal-700 text-white hover:bg-teal-600',
  },
  skip: {
    // `text-dark-1` rather than the body `text-dark-2`: on `bg-dark-6` it is 6.28:1, between
    // `rose-400` (5.61:1) and `teal-400` (8.11:1), so Skip reads as a peer of the other two.
    // `text-dark-2` is 4.73:1 — it passes, but it would make the abstention look disabled.
    idle: 'border-dark-3/60 text-dark-1 hover:bg-dark-4/60 hover:text-dark-0',
    chosen: 'border-dark-2 bg-dark-3 text-white hover:bg-dark-2',
  },
};

/**
 * Who a stored ruling belongs to, and when — one string, separators included.
 *
 * 🔴 RESOLVED TO "you" ONLY FOR THE READER, and by STRING comparison, because a string is what the
 * column holds. `Number(verdictBy) === viewerId` would read `'007'` as moderator 7, and would read
 * any non-numeric value as `NaN`, which matches nothing — including itself.
 *
 * Everyone else stays a number on purpose. `verdict_by` stores the moderator's id rather than their
 * username precisely because a rename cannot move an id, so resolving it back to a name here would
 * re-introduce the failure the column was shaped to avoid: months later, a handle that now belongs
 * to somebody else printed beside a ruling they did not make.
 *
 * `null` means nobody has ruled, and the caller renders nothing — not an empty attribution.
 */
export function verdictAttribution(
  verdictBy: string | null,
  verdictAt: Date | null,
  viewerId: number | null,
  formatTime: (at: Date) => string
): string | null {
  if (verdictBy === null) return null;
  const who =
    viewerId !== null && verdictBy === String(viewerId) ? 'you' : `moderator #${verdictBy}`;
  return verdictAt === null ? who : `${who} · ${formatTime(verdictAt)}`;
}

/**
 * The tail after the named members of a cluster: `" and 6 more"`, or nothing when they are all named.
 *
 * 🔴 THE LEADING SPACE IS THE POINT, and it is why this is a function rather than template text. It
 * used to be typed at the start of an `{#if}` block, where Svelte trims it — so the board rendered
 * the last named account id welded to the word, `…1234and 6 more`.
 */
export function moreMembersLabel(others: number, named: number): string {
  const more = others - named;
  return more > 0 ? ` and ${num(more)} more` : '';
}

/**
 * A producer's confidence, two digits, with the one reading that is not self-evident.
 *
 * Two digits rather than a percentage: these are the producer's own 0..1 scores and are NOT
 * comparable across detectors, so "94%" invites exactly the cross-detector ranking that would be
 * meaningless, while a bare decimal reads as the raw number it is.
 *
 * 🔴 AND 0.00 IS NOT "NO SIGNAL" — it is a judged verdict of "not abuse", and it renders beside a
 * reason that describes the evidence in detail, which reads as self-contradictory unless it is
 * labelled. Every finding whose reason begins "Judged and deliberately NOT actioned" carries exactly
 * 0.00. `AbuseFindingsPanel.svelte` says the same thing about the same rows on the user-lookup page;
 * this board showed the bare number, so the two screens gave a moderator different readings of one
 * row. They are separate strings with separate owners — the panel's is pinned by
 * `apps/moderator/src/routes/abuse/__tests__/user-findings-round-trip.test.ts`.
 */
export const confidenceLabel = (value: number): string =>
  value === 0 ? '0.00 — judged not abuse, not "unscored"' : value.toFixed(2);
