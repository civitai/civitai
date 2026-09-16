import type { StagedImageFacts } from '../evidence';
import type { BotAccountHeuristic } from '../scoring';
import { rampScore } from './ramp';

/**
 * HEURISTIC 4 — uploads that were never published.
 *
 * WHAT IT DETECTS: an account whose images are STAGED rather than posted — each one carrying no
 * generation metadata (it was not produced on this site) and attached to no post (there is no page
 * it appears on). The predicate is applied in the query; see `evidence.ts#stagedImageSampleArgs`.
 * The score rises with how many such uploads an account has. It is also measured a second way — how
 * many were created inside ONE SECOND, which is a batch a program submitted rather than a person
 * picking files — but at today's boundaries that second measure cannot change the score, only
 * report itself; see `BURST_ONE_AT`, which states the arithmetic rather than implying otherwise.
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
 * person who dragged in a couple of files and then closed the tab produces exactly this shape, and
 * so does a person who is still choosing a title while the run walks past — including the
 * same-second burst, because a multi-file drop is one batch however it was started. Nothing here can
 * tell those from an automated stage, and no boundary removes the class: it is the same population
 * at a smaller size. What bounds it is the cohort itself — every member is an account under a day
 * old that has already posted something — and the shadow phase, where
 * `heuristic:asset-staging:sole_signal` counts the findings this signal carried alone, which is
 * exactly the population such a collision inflates.
 *
 * 🔴 AND THAT CLASS GOT BIGGER IN THE CHANGE THAT SET THESE BOUNDARIES, WHICH IS THE COST OF THEM.
 * Firing from TWO staged uploads rather than from eight means a two-file abandoned drag now scores
 * enough to be reported on its own, where before it scored a fraction of the cut. That is the
 * deliberate trade — the old boundary was calibrated against a predicate this heuristic does not
 * ship (see `STAGED_ONE_AT`) and selected almost nobody — but the consequence is that this signal's
 * precision now rests entirely on the shadow phase measuring it, not on the boundary being cautious.
 * Anyone reading `sole_signal` for this id is reading the number that decides whether that trade
 * was right.
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
 * The ramp saturates far below it — more than an order of magnitude, and the margin WIDENED when
 * the boundary moved down to 3 — so no real account is mis-scored by the cap today; that is a
 * property of where the two numbers sit and not a guarantee, and moving either is the moment to
 * re-check it. The relationship is asserted in `evidence.test.ts` rather than left to a reader.
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
 * 🔴 `oneAt: 3` IS DERIVED FROM THE REPORTING CUT, NOT PICKED — AND THE DERIVATION IS THE REASON IT
 * IS 3 AND NOT SOMETHING ROUNDER. The requirement is that TWO staged uploads is enough for this
 * heuristic to put an account on the board ON ITS OWN. `scoreAccount` divides by the WHOLE
 * registry's weight, so a lone sub-score `s` blends to `s / n` and is compared against
 * `MIN_REPORTED_CONFIDENCE`, which is `LONE_SIGNAL_CUT / n` — the `n`s cancel, and a lone signal is
 * reported exactly when `s >= LONE_SIGNAL_CUT`. With `zeroAt = 1` the ramp puts a count of two at
 * `(2 - 1) / (oneAt - 1)`, so:
 *
 *     1 / (oneAt - 1) >= LONE_SIGNAL_CUT (0.45)   ⟺   oneAt <= 1 + 1/0.45 = 3.22…
 *
 * The largest integer satisfying it is 3. A pair then scores 0.5 — clear of the cut by more than a
 * rounding step, which is deliberate so a mutant nudging either constant cannot land between them —
 * and three saturates. `oneAt = 4` would put a pair at 0.333, below the cut, which is the behaviour
 * this change exists to remove. The property is pinned end-to-end, through the real blend and the
 * real partition, by the case named "THE FIRING POINT: a LONE asset-staging signal is REPORTED at
 * two staged uploads, not one" in `__tests__/heuristics.test.ts`.
 *
 * 🔴 WHERE THIS CAME FROM, AND WHY THE PREVIOUS VALUE (8) WAS NOT EVIDENCE. The old boundary was
 * calibrated against a predicate this heuristic does not ship: a RATIO test — "all of the account's
 * images are staged" — rather than the unratioed COUNT above. Re-measured against the SHIPPED
 * predicate on a matured cohort (accounts old enough for a moderation outcome to exist, graded
 * against that cohort's own base actioned rate), the old volume boundary selected a population far
 * too small to carry any signal, while a firing point of two separated strongly and on a population
 * large enough to mean something. That measurement — its cohort definition, denominators, per-cell
 * rates and lift — lives in the private infra repo and is deliberately not restated here, because
 * this repository is public.
 */
export const STAGED_ZERO_AT = 1;
export const STAGED_ONE_AT = 3;

/**
 * The same two boundaries for the SAME-SECOND half — and they are now the SAME NUMBERS as the
 * volume half's, which is a statement about this arm and not a coincidence.
 *
 * `zeroAt: 1` because every staged upload shares its own second with itself, so a burst of one is
 * what a member with any staged image at all has and it must be worth nothing. Two inside one second
 * is the smallest that scores, which is what "created together" means at this resolution.
 *
 * `oneAt: 3` is the identical cut arithmetic `STAGED_ONE_AT` is derived with: a same-second PAIR
 * must clear `LONE_SIGNAL_CUT` on its own, and 3 is the largest integer boundary that does.
 *
 * 🔴 THE BURST ARM THEREFORE CHANGES NOTHING ABOUT THE SCORE — NOT WHETHER THIS HEURISTIC FIRES,
 * NOT HOW HIGH IT SCORES — AND SAYING SO PLAINLY IS THE POINT. A same-second group is a SUBSET of
 * the staged rows, so `largestSameSecondBurst <= count` ALWAYS: `evidence.ts` builds both from one
 * walk over the same rows, and a row whose timestamp will not parse increments `count` while being
 * left out of the burst tally, which can only widen the gap. `rampScore` is monotonic, so feeding
 * the smaller of two values through the SAME pair of boundaries cannot produce the larger score.
 * Hence `max(volume, burst) === volume` identically at these constants. Anything implying the burst
 * half independently widens the net would be false.
 *
 * 🔴 SO IT HAS NO SCORING RATIONALE TODAY, AND NONE IS INVENTED HERE. It previously had one: a
 * tighter boundary pair (4 against 8) expressing "concentration is the stronger of the two claims",
 * which was a real difference in behaviour. Moving the firing point to two consumed that rationale
 * outright, because the volume half now fires everywhere the burst half possibly could. The
 * re-measurement does show same-second concentration separating harder than raw volume one count
 * further up, which is the only thing that would justify tightening this boundary below the volume
 * one again — it rests on too few members to author a constant from, so it has not been used, and
 * inventing a gradient the measurement does not support is exactly what this comment exists to
 * prevent.
 *
 * What the arm still produces is real and is NOT the score: `assetStagingHalfScores` reports the
 * halves separately (`heuristic:asset-staging:fired_burst` in `run.ts`), which is how the shadow
 * phase will answer whether concentration separates at all, and `explain` names the batch to the
 * moderator. If a later measurement says it does not separate, the honest edit is to DELETE the arm
 * — not to widen it until it appears to do something.
 */
export const BURST_ZERO_AT = 1;
export const BURST_ONE_AT = 3;

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
 * phase grades a signal on its own or not at all.
 *
 * 🔴 AND FOR THE BURST HALF THIS IS NOW THE ONLY PLACE IT EXISTS AT ALL. Its question — "is
 * same-second concentration doing work the volume half was not already doing" — used to be partly
 * answerable from the SCORE, because the burst boundaries were tighter. They are not any more, so
 * `max` is identically `volume` (see `BURST_ONE_AT`) and the score carries no information about
 * this half whatsoever. The counters `run.ts` builds from these two values are therefore the whole
 * of the evidence that will decide whether the arm gets re-tightened or deleted. Read carefully:
 * `burst > 0` here does NOT mean the burst half contributed anything to the account's sub-score.
 *
 * They may BOTH be non-zero on one account, deliberately: they are two questions about the same
 * uploads, not a partition of them. The reverse — `burst > 0` while `volume` is 0 — cannot occur
 * for any index the evidence layer can build, since a same-second group is a subset of the rows.
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
  //
  // 🔴 AT TODAY'S CONSTANTS THIS `max` IS IDENTICALLY `volume` — the proof is on `BURST_ONE_AT`,
  // and the identity is pinned by the case named "the burst half NEVER exceeds the volume half at
  // today's boundaries". It is kept rather than collapsed to a bare `volume` because the identity is a
  // property of the two boundary PAIRS being equal, not of the model: the moment either pair moves,
  // `max` is the correct combination and a hardcoded `volume` would silently drop the burst arm
  // with nothing failing. Read it as "the arm is inert, not absent" — the pin is what makes a
  // boundary change that revives it visible instead of assumed.
  //
  // 🔴 MEASURED, SO THE CLAIM IS NOT LEFT AS REASONING: replacing this line with `return volume`
  // leaves the whole suite GREEN (418/418). That mutant SURVIVES, and it survives because it is
  // semantically equivalent at these constants, not because the tests are thin — which is the
  // difference this comment exists to record. Under `BURST_ONE_AT = 2` the equivalence breaks and
  // the subset pin goes red, which is the control proving the guard is reachable rather than
  // decorative.
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
