import type { BadgeVariant } from '@civitai/ui/components/ui/badge/index.js';
import { num, plural } from '$lib/format';
import type { Decision, GroupableFinding } from '$lib/abuse-decisions';
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

/**
 * The question the three buttons answer, rendered above them.
 *
 * 🔴 IT NAMES THE ACCOUNT, AND THAT IS THE WHOLE FIX. While the buttons were labelled against the
 * DETECTOR ("Correct" / "False positive") the stored verdict's meaning INVERTED between two
 * populations of this board, and nothing on screen said which one a moderator was looking at: on a
 * flagged-but-unactioned finding "Correct" meant *this is abuse*, while on a `confidence = 0` finding
 * — where the detector's own reason opens "Judged and deliberately NOT actioned", i.e. it decided the
 * account was FINE — "Correct" meant *this is NOT abuse*. Same button, opposite claim. Asking about
 * the account instead has one answer in both.
 */
export const VERDICT_QUESTION = 'Your verdict — is this account abusing the site?';

/**
 * What a moderator is being asked, in their words rather than the detector author's.
 *
 * 🔴 THESE NAME THE ACCOUNT, NEVER THE DETECTOR — see `VERDICT_QUESTION` for the inversion that
 * forces it. The stored codes stay `tp`/`fp`: they are the database's CHECK-constrained values and
 * renaming them would be a hand-applied migration for no behavioural gain, so what changed is the
 * question they answer, not the column.
 */
export const VERDICT_LABEL: Record<AbuseVerdict, string> = {
  tp: 'This is abuse',
  fp: 'This is not abuse',
  skip: 'Skip',
};

/**
 * Rendered as visible text under each button — NOT as a `title` tooltip.
 *
 * "TP" is jargon for the person who wrote the detector and nothing at all for the moderator being
 * asked to rule, so the expansion has to be readable without discovering that hovering does
 * something. A tooltip also never appears in a screenshot, which is how this team reports.
 *
 * 🔴 BOTH JUDGEMENTS CARRY THE "regardless" CLAUSE, and the repetition is deliberate. Naming the
 * independence under only one button implies the other IS relative to what the detector did, which is
 * the reading this change exists to remove.
 */
export const VERDICT_HINT: Record<AbuseVerdict, string> = {
  tp: 'This account is abusing the site — regardless of what the detector did.',
  fp: 'This account is not abusing the site — regardless of what the detector did.',
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
 * labelled.
 *
 * ⚠️ THE BICONDITIONAL IS MEASURED OVER THE LIVE DATA, BUT IT IS NOT ENFORCED. Measured 2026-10-01
 * against the whole finding table (n=4,929): a 2x2 of `(confidence = 0)` against
 * `(reason LIKE 'Judged and deliberately NOT actioned%')` returns 903 rows in true/true, 4,026 in
 * false/false, and ZERO in either cross-cell. So BOTH directions hold today — every 0.00 row carries
 * that reason and every row carrying it is 0.00 — and the string this prints is a true statement
 * about every row that exists.
 *
 * 🔴 WHAT IS UNVERIFIED IS THAT IT STAYS TRUE, AND THE REASON IS WHOSE CODE WRITES IT. No in-repo
 * producer emits a literal 0 (`bot-account-detection` reports a blend, `reaction-withdrawal-detection`
 * is bounded at >= 0.90), so the entire `confidence = 0` population is written by the two producers
 * whose code lives elsewhere — the same two this board otherwise refuses to depend on the prose of.
 * Nothing constrains them to keep the pairing, and a producer that someday emits 0.00 meaning
 * "unscored" would hand a moderator a false input with nothing here to notice. A grep of THIS repo
 * cannot settle that either way: it is the wrong population, which is how an earlier draft of this
 * comment concluded the claim was never checked at all.
 *
 * Re-measure rather than trusting this paragraph — it is a reading of one day's rows:
 *   SELECT (confidence = 0), (reason LIKE 'Judged and deliberately NOT actioned%'), count(*)
 *     FROM abuse_detection_finding GROUP BY 1, 2;
 * Two populated cells on the diagonal means it still holds; anything in a cross-cell means this
 * label is now lying on that population and the string has to change.
 *
 * `AbuseFindingsPanel.svelte` says the same thing about the same rows on the user-lookup page;
 * this board showed the bare number, so the two screens gave a moderator different readings of one
 * row. They are separate strings with separate owners — the panel's is pinned by
 * `apps/moderator/src/routes/abuse/__tests__/user-findings-round-trip.test.ts`.
 */
export const confidenceLabel = (value: number): string =>
  value === 0 ? '0.00 — judged not abuse, not "unscored"' : value.toFixed(2);

/**
 * An account id the board links into User Lookup, with the text that immediately precedes it.
 *
 * 🔴 THE SEPARATOR TRAVELS WITH THE LINK, and that is the entire reason this shape exists rather than
 * a bare `number[]`. Rendered as `{l.prefix}<a …>` the two sit adjacent in the template with no
 * whitespace between them, so there is nothing for Svelte to trim — whereas a separator typed as
 * `{#each}`-block text is deleted at compile time, which is exactly how `…1234and 6 more` shipped.
 *
 * 🔴 `key` IS THE FINDING'S PRIMARY KEY AND `userId` IS NOT UNIQUE — DO NOT KEY THE LOOP ON `userId`.
 * `abuse_detection_finding` has no unique index on `(run_id, user_id)`; the ingest service says so in
 * as many words and documents that the wire contract permits two findings for one account in one run.
 * `group_key` is derived from an account attribute, so those two land in the SAME cluster and
 * `members.slice(1, …)` then yields the same account id twice. Svelte 5 throws `each_key_duplicate`
 * outside DEV as well as in it, so a duplicate key takes the whole run page down on hydration rather
 * than mis-wiring one row. This field exists so the template has the PK to key on.
 */
export type BulletLink = { userId: number; prefix: string; key: string };

/**
 * One line of the key-info list above a finding's prose.
 *
 * `label` is the field, `text` the plain part of the value, `links` the account ids rendered after it,
 * `tail` whatever follows the last one. 🔴 EVERY SEPARATOR BETWEEN THOSE FOUR LIVES INSIDE ONE OF
 * THEM — none is typed in the template, for the reason `BulletLink` gives. The label is separated from
 * the value by a CSS gap rather than by whitespace, so that join cannot be trimmed either.
 */
export type FindingBullet = {
  /** Stable `{#each}` key. */
  key: string;
  label: string;
  text: string;
  links: BulletLink[];
  tail: string;
  /**
   * The CATEGORICAL half of the value, as a Badge; `null` when the value is all prose.
   *
   * 🔴 THE BADGE CARRIES ONLY THE CATEGORY, NEVER PRODUCER FREE TEXT. `badgeVariants.base` sets
   * `whitespace-nowrap shrink-0 overflow-hidden`, so a Badge can neither wrap nor shrink: an action
   * name — up to 64 characters of producer-supplied string — pushes straight out of the card. The name
   * therefore goes in `text`, which wraps, and the Badge keeps the one word that has to pop.
   *
   * 🔴 AND `text`/`links`/`tail` ARE STILL RENDERED WHEN THIS IS SET. A template branch that drew the
   * Badge *instead of* them would silently discard half of any future bullet using both.
   */
  badge: { variant: Extract<BadgeVariant, 'destructive' | 'secondary'>; text: string } | null;
};

/** How many of a cluster's members are named before the count takes over. */
export const NAMED_MEMBERS = 4;

/**
 * The scannable facts above a finding's reason — ONLY from fields the board already holds.
 *
 * 🔴 NOTHING HERE PARSES `reason` OR `summary`, AND NOTHING MAY START. Five detectors post to this
 * board and each writes its own prose shape; two of them — accounting for most of the runs — have no
 * code in this repo at all, so their wording is not ours to depend on. A per-detector text parser
 * would be a heuristic over formats we do not control, breaking silently and invisibly on a producer's
 * reword. The prose itself stays reachable, in full, behind the disclosure below the list.
 *
 * 🔴 BOTH PRODUCER FIGURES KEEP THE WORD "(reported)" — it is in the LABEL so it is stated once per
 * figure rather than twice per card. Neither `actioned`/`action` nor `confidence` is ever cross-checked
 * against the action log; without the hedge this list reads as the board CONFIRMING something was done,
 * when it is relaying a self-report into a human decision and nothing more.
 *
 * `group_key` is deliberately NOT a bullet. The cluster's SIZE is the part that changes the decision —
 * the key itself is an opaque producer string whose own schema comment constrains it to carry nothing
 * the reason does not already say, so rendering it adds an identifier and no information.
 */
export function findingBullets(decision: Decision<RenderableFinding>): FindingBullet[] {
  const lead = decision.lead;
  const size = decision.members.length;
  const others = size - 1;
  const named = decision.members.slice(1, NAMED_MEMBERS + 1);

  const bullets: FindingBullet[] = [
    // Identity first: it is the subject of the decision.
    {
      key: 'account',
      label: 'Account',
      text: '',
      links: [{ userId: lead.userId, prefix: '', key: String(lead.id) }],
      tail: '',
      badge: null,
    },
  ];

  // 🔴 SECOND WHEN IT EXISTS, because it changes what the buttons below DO: ruling one account and
  // ruling eleven are different acts, and the size qualifies the account named above it.
  if (others > 0) {
    bullets.push({
      key: 'cluster',
      label: 'Ruled together',
      text: plural(size, 'account'),
      links: named.map((m, i) => ({
        userId: m.userId,
        prefix: i === 0 ? ' — ' : ', ',
        key: String(m.id),
      })),
      tail: moreMembersLabel(others, named.length),
      badge: null,
    });
  }

  bullets.push(
    // What already happened, before what the producer thought of it: an action has consequences a
    // score does not, and it is the fact a moderator checks first.
    actionBullet(decision.members),
    {
      key: 'confidence',
      // 🔴 THE LEAD'S SCORE, WHICH ON A CLUSTER IS THE HIGHEST ONE — `groupFindings` sorts by
      // `actioned desc, confidence desc` and takes `sorted[0]`, and the whole board is ordered on it.
      // So on a cluster this is a maximum presented as a single figure, not the cohort's band. Left as
      // the lead's deliberately: it is the number the queue is ranked by, and it is what a moderator
      // comparing this card against its neighbours is reading.
      label: 'Confidence (reported)',
      text: confidenceLabel(lead.confidence),
      links: [],
      tail: '',
      badge: null,
    }
  );

  return bullets;
}

/**
 * What the detector did — COUNTED ACROSS THE CLUSTER, not read off the lead.
 *
 * 🔴 THE LEAD IS ACTED-ON IF *ANY* MEMBER IS, so reporting its flag as the decision's reads "all 11 of
 * these were excluded" when one was. `groupFindings` sorts `actioned desc` and takes `sorted[0]`, so a
 * single acted-on member promotes itself to lead. A moderator who believes the cohort was already
 * handled declines to act, which is the expensive direction of that error — and the new layout puts
 * this line directly beneath the cluster size, which is the adjacency that invites the misreading.
 *
 * 🔴 THE ACTION NAMES ARE DISTINCT AND JOINED HERE, separator included, for the reason every other
 * string in this module is built here rather than in the template.
 */
function actionBullet(members: readonly RenderableFinding[]): FindingBullet {
  const acted = members.filter((m) => m.actioned);
  const solo = members.length === 1;
  const names = [...new Set(acted.map((m) => m.action).filter((a): a is string => a !== null))];

  return {
    key: 'action',
    label: 'Detector action (reported)',
    // 🔴 `action` IS NULLABLE IN THE TYPE AND AN EMPTY `text` IS NOT DEAD CODE. A CHECK constraint
    // forbids `actioned` without an `action`, but it is added by a hand-applied DDL file and the column
    // the board READS is plain `text | null` — so a row written before the constraint renders a bare
    // `Acted` rather than `Acted: ` with a dangling separator a moderator would read as a failed load.
    // Do NOT "simplify" this to `action ?? 'unknown'`: that prints a value no producer reported, on a
    // surface whose entire claim is honest relaying.
    text: names.join(', '),
    links: [],
    tail: '',
    badge:
      acted.length > 0
        ? {
            variant: 'destructive',
            text: solo ? 'Acted' : `Acted on ${num(acted.length)} of ${num(members.length)}`,
          }
        : {
            // Spelled out rather than blank: "detected, scored, deliberately left alone" is the
            // commonest row on this board, and a blank reads as missing data.
            variant: 'secondary',
            text: solo ? 'Not acted on' : `None of ${num(members.length)} acted on`,
          },
  };
}
