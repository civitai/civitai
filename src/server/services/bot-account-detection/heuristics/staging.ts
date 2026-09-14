import type { StagedImageFacts } from '../evidence';
import type { BotAccountHeuristic } from '../scoring';
import { rampScore } from './ramp';

/**
 * HEURISTIC 4 — uploads that were never published.
 *
 * WHAT IT DETECTS: an account whose images are STAGED rather than posted — each one carrying no
 * generation metadata (it was not produced on this site) and attached to no post (there is no page
 * it appears on). The predicate is applied in the query; see `evidence.ts#stagedImageSampleArgs`.
 * The score rises with how many such uploads an account has, and rises faster when several of them
 * were created inside ONE SECOND, which is a batch a program submitted rather than a person picking
 * files.
 *
 * 🔴 IT IS THE FIRST HEURISTIC HERE THAT IS NOT A RING DETECTOR, AND THAT IS ITS POINT. The other
 * three ask "how many OTHER new accounts share this" — a registration IP, an email domain, a
 * comment, a filename — so all three are blind to a single actor working alone, and two of them are
 * blind to a coordinated one that varied the shared thing. This one asks only about the account in
 * front of it, so it needs no cohort-level agreement to fire and no second account to exist. It is
 * the only signal in the registry that scores a lone operator.
 *
 * 🔴 WHY THE CONJUNCTION AND NOT EITHER HALF. `postId IS NULL` alone is ordinary: an upload sits
 * unattached for as long as it takes someone to finish a post, so a snapshot at any instant catches
 * real people mid-flow. `meta IS NULL` alone is even more ordinary — every image uploaded from a
 * disk rather than generated here has no generation metadata, which is a very large share of the
 * site. It is the pair that is unusual: material brought in from elsewhere AND never published.
 *
 * 🔴 THE KNOWN FALSE POSITIVE, NAMED RATHER THAN TUNED AWAY: AN ABANDONED OR IN-FLIGHT UPLOAD. A
 * person who dragged in eight files and then closed the tab produces exactly this shape, and so does
 * a person who is still choosing a title while the run walks past — including the same-second burst,
 * because a multi-file drop is one batch however it was started. Nothing here can tell those from an
 * automated stage, and no boundary removes the class: it is the same population at a smaller size.
 * What bounds it is the cohort itself — every member is an account under a day old that has already
 * posted something — and the shadow phase, where `heuristic:asset-staging:sole_signal` counts the
 * findings this signal carried alone, which is exactly the population such a collision inflates.
 *
 * 🔴 THE KNOWN FALSE NEGATIVE: A STAGE THAT WAS LATER PUBLISHED. An account that stages forty images
 * and then attaches them to a post scores 0 here from the moment it does, because `postId` stops
 * being null. That is not an oversight to be widened away — the heuristic's claim is about unposted
 * material, and an account that published is making a different claim about itself — but it does
 * mean this signal is strongest on the accounts caught BEFORE they finish, and a run is a daily
 * snapshot rather than a history.
 *
 * 🔴 IT SEES A SAMPLE, NOT A CENSUS, AND HERE THAT BOUNDS THE SCORE RATHER THAN ONLY THE READ. The
 * read is budgeted (`MAX_STAGED_IMAGE_SAMPLES`) and per-member capped
 * (`MAX_STAGED_IMAGES_PER_MEMBER`), so `count` is the number SAMPLED and never more than that cap.
 * The ramp saturates an order of magnitude below it, so no real account is mis-scored by the cap
 * today; that is a property of where the two numbers sit and not a guarantee, and moving either is
 * the moment to re-check it.
 *
 * 🔴 A ZERO FROM A DEAD SOURCE IS THE DANGEROUS ZERO FOR THIS HEURISTIC SPECIFICALLY. Its index is
 * empty both when a member staged nothing and when the read never ran, and unlike the ring
 * heuristics the second case is not a weaker version of the first — it is the opposite claim about
 * the account. The heuristic does not try to distinguish them itself, because it cannot: the
 * distinction lives on `signals.sources.stagedImages`, which `run.ts` publishes as a counter AND
 * states in the report summary. Nothing here may be read as evidence that an account staged nothing
 * without that flag beside it.
 */

/** The id is a metric key and a board-facing sub-score name — an identifier, not a sentence. */
export const ASSET_STAGING_ID = 'asset-staging';

/**
 * The most staged uploads that are still worth nothing, and the number at which the volume half is
 * fully convinced.
 *
 * `zeroAt: 1` means TWO staged uploads is the smallest count that scores anything. One is the
 * single commonest shape on the site that matches this predicate at all — somebody uploaded a file
 * and did not finish — and scoring it would fire on a large share of every day's genuine signups,
 * which is the "fires on 90% of accounts" uselessness the scoring seam exists to make visible.
 *
 * `oneAt: 8` is a judgement and is the constant here most likely to be wrong. It is not derived from
 * anything: eight unpublished, externally-sourced uploads from an account less than a day old is
 * where this stops looking like an abandoned session, and the shadow phase's counters are what
 * should replace that sentence with a measurement.
 */
export const STAGED_ZERO_AT = 1;
export const STAGED_ONE_AT = 8;

/**
 * The same two boundaries for the SAME-SECOND half.
 *
 * `zeroAt: 1` because every staged upload shares its own second with itself, so a burst of one is
 * what a member with any staged image at all has and it must be worth nothing. Two inside one second
 * is the smallest that scores, which is what "created together" means at this resolution.
 *
 * The burst boundaries sit far below the volume ones — 4 against 8 — deliberately: concentration is
 * the stronger of the two claims. Eight uploads spread over a day is a person with a backlog; four
 * inside one second is a submission nobody typed. Both are judgements, and the burst half is the one
 * an innocent multi-file drag-and-drop walks straight into, which is why the false positive above is
 * stated in the header rather than defended against here.
 */
export const BURST_ZERO_AT = 1;
export const BURST_ONE_AT = 4;

/** What this account staged, or zeroes for a member with nothing sampled. `0`/`0` is also what an
 *  UNAVAILABLE source yields — see the header; the flag, not this function, tells the two apart. */
export function stagedImageFacts(
  userId: number,
  signals: { stagedImagesByUser: Map<number, StagedImageFacts> }
): StagedImageFacts {
  return signals.stagedImagesByUser.get(userId) ?? { count: 0, largestSameSecondBurst: 0 };
}

/**
 * The two halves of this account's score, separately.
 *
 * 🔴 THE DECOMPOSITION IS THE POINT, AND `fired` CANNOT PROVIDE IT — the same argument
 * `contentTemplatingSourceScore` makes one heuristic over. With two measures behind one id,
 * `heuristic:asset-staging:fired` cannot say WHICH of them is earning its place, and the shadow
 * phase grades a signal on its own or not at all. The concrete question these answer is whether the
 * burst half is doing any work the volume half was not already doing.
 *
 * They may BOTH be non-zero on one account, deliberately: they are two questions about the same
 * uploads, not a partition of them.
 */
export function assetStagingHalfScores(
  userId: number,
  signals: { stagedImagesByUser: Map<number, StagedImageFacts> }
): { volume: number; burst: number } {
  const facts = stagedImageFacts(userId, signals);
  return {
    volume: rampScore(facts.count, STAGED_ZERO_AT, STAGED_ONE_AT),
    burst: rampScore(facts.largestSameSecondBurst, BURST_ZERO_AT, BURST_ONE_AT),
  };
}

export const assetStagingHeuristic: BotAccountHeuristic = {
  id: ASSET_STAGING_ID,
  description:
    'How many images the account uploaded that carry no generation metadata and were never ' +
    'attached to a post, and how many of those were created inside the same second. The only ' +
    'heuristic here that scores an account on its own uploads rather than on what it shares with ' +
    'other new accounts. Over a budgeted, per-account-capped sample.',
  weight: 1,
  // 🔴 `max`, NOT A SUM, for the reason `registration-cluster` combines its two halves with `max`:
  // an account caught by both is not twice as suspicious as one caught by either, and a sum would
  // make this sub-score stop meaning "how far past ordinary these uploads are". A burst is a subset
  // of the count, so summing would also double-count the same rows.
  score: ({ member, signals }) => {
    const { volume, burst } = assetStagingHalfScores(member.userId, signals);
    return Math.max(volume, burst);
  },
  explain: ({ member, signals }, score) => {
    if (score <= 0) return null;
    const facts = stagedImageFacts(member.userId, signals);
    // 🔴 THE BURST CLAUSE IS GATED ON THE BURST SCORE, NOT ON A SECOND COPY OF ITS BOUNDARY. Writing
    // `facts.largestSameSecondBurst > BURST_ZERO_AT` here would be the same rule in two places, and
    // the two would disagree the first time that boundary moved — the defect
    // `domainClusterIsNamedInReason` exists one heuristic over to prevent. What a moderator is told
    // fired and what actually scored are then the same question by construction.
    const { burst } = assetStagingHalfScores(member.userId, signals);
    // The account's own image total rides in on the cohort read, so stating it costs no query — and
    // it is the number that tells a moderator whether these uploads are ALL of this account's
    // images or a corner of them. The heuristic deliberately does not require "all" (the per-member
    // cap makes that test unreachable on exactly the busiest accounts, and a moderation outcome
    // would silently flip it), so the ratio is disclosed rather than folded into the score.
    const clauses = [
      `${facts.count} of this account's ${member.posts.all.images} uploaded image(s) carry no ` +
        `generation metadata and are attached to no post`,
    ];
    if (burst > 0)
      clauses.push(`${facts.largestSameSecondBurst} of them were created within the same second`);
    return clauses.join('; ');
  },
};
