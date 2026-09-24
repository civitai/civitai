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
 * "1 finding" / "2 findings" — a count and the noun it counts, agreeing.
 *
 * Only for nouns THIS APP writes. A detector's own `reason` text is the producer's prose and is
 * rendered verbatim, `item(s)` and all: rewriting another system's sentences here would make the
 * board disagree with the payload it is reporting.
 */
export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${num(count)} ${count === 1 ? one : many}`;
