import { plural } from '../../abuse-report-prose';
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
 * enough to be reported on its own, where before it scored a fraction of the cut — and since the
 * volume ramp was flattened to a step at two (see `STAGED_ONE_AT`) that drag no longer scores a
 * half, it scores the maximum. That is the deliberate trade — the old boundary was calibrated
 * against a predicate this heuristic does not ship and selected almost nobody, and the rung above
 * the pair graded WORSE than the pair rather than better — but the consequence is that this
 * signal's precision now rests entirely on the shadow phase measuring it, not on the boundary being
 * cautious. Anyone reading `sole_signal` for this id is reading the number that decides whether
 * that trade was right.
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
 * The ramp saturates far below it — 50 against a boundary of 2, and the margin WIDENED again when
 * that boundary moved down — so no real account is mis-scored by the cap today; that is a property
 * of where the two numbers sit and not a guarantee, and moving either is the moment to re-check it.
 * ⚠️ `evidence.test.ts` asserts a RELATED BUT WEAKER thing — that the cap exceeds four times the
 * boundary, i.e. 8, not the 25× above — so read that guard as a floor under a per-member cap dropped
 * near the ramp, not as a check on this sentence. The margin itself is pinned only by the two
 * literals beside it.
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
 * 🔴 `oneAt: 2` MAKES THE RAMP SATURATE AT THE FIRING POINT, AND THAT IS THE WHOLE OF THE FIX IT
 * CARRIES. A rising ramp puts its TOP rung on the largest counts, and on this predicate the largest
 * counts are the wrong population. A coordinated upload clusters at exactly TWO assets — an avatar
 * and a header, which is what a profile needs and no more — while a legitimate profile setup, a
 * business or a creator bringing in a kit, runs to THREE OR MORE. With the previous `oneAt = 3` a
 * pair scored 0.5 and everything from three up scored 1.0, so the rung this heuristic weighted
 * HIGHEST was the rung carrying disproportionately many legitimate accounts, and the shape it
 * exists to find sat at half of what it selected. Saturating at 2 removes the inversion in the one
 * way the shared ramp can express: `score(2) === score(3+)`.
 *
 * 🔴 A PLATEAU, NOT A SUPPRESSION, AND THE DIFFERENCE IS DELIBERATE. `count >= 3` still scores 1.0.
 * It is the WORSE of the two arms, not an empty one — it still carries genuine catches — so the
 * requirement this constant satisfies is that it must stop OUTSCORING a pair, never that it stop
 * scoring. `rampScore` is monotonically non-decreasing by construction and throws on
 * `oneAt <= zeroAt`, so a DECLINING shape is not expressible in it at all without a second ramp
 * term; between the two shapes that are expressible, the plateau is one constant and adds no
 * machinery. Both the ordering and the non-suppression are pinned by the case named "THE ORDERING:
 * three or more staged uploads never OUTSCORES exactly two" in `__tests__/heuristics.test.ts`,
 * which asserts `>=` rather than two literals precisely so that a later re-shaping backed by its
 * own measurement does not have to fight a test pinning this implementation.
 *
 * 🔴 IT STILL SATISFIES THE REPORTING-CUT DERIVATION THAT SET THE PREVIOUS VALUE — CHECKED, NOT
 * ASSUMED, BECAUSE THAT IS THE PROPERTY A READER CARES ABOUT. The requirement is that TWO staged
 * uploads is enough to put an account on the board ON ITS OWN. `scoreAccount` divides by the WHOLE
 * registry's weight, so a lone sub-score `s` blends to `s / n` and is compared against
 * `MIN_REPORTED_CONFIDENCE`, which is `LONE_SIGNAL_CUT / n` — the `n`s cancel, and a lone signal is
 * reported exactly when `s >= LONE_SIGNAL_CUT`. With `zeroAt = 1` the ramp puts a count of two at
 * `1 / (oneAt - 1)`, so the cut requires `oneAt <= 1 + 1/0.45 = 3.22…`. The previous value took the
 * LARGEST integer satisfying that; 2 is simply a smaller one, and a pair now scores 1.0 — clear of
 * the 0.45 cut by the widest margin available rather than by a rounding step. Note what changed
 * about the derivation's STATUS: `oneAt` is no longer DERIVED from `LONE_SIGNAL_CUT`, it is set by
 * the ordering above and CHECKED against the cut. The end-to-end property is pinned by the case
 * named "THE FIRING POINT: a LONE asset-staging signal is REPORTED at two staged uploads, not one".
 *
 * 🔴 THE COST, NAMED RATHER THAN TUNED AWAY: THIS HALF NOW HAS NO GRADIENT AT ALL. It is a step —
 * 0 below two, 1 at two and above — so the sub-score can no longer express "more staged than that"
 * and a moderator ordering a queue by confidence gets no separation between a pair and forty. That
 * is the honest consequence of a monotone helper meeting a non-monotone finding, and it is not
 * hidden: the COUNT itself is still disclosed verbatim to the moderator by `explain`. If the shadow
 * phase shows the two arms want separating rather than levelling, the edit that earns it is a real
 * re-shape with its own measurement — not widening this constant back and reinstating the inversion.
 *
 * 🔴 AND THE RUN'S OWN COUNTERS CAN NO LONGER PRODUCE THAT MEASUREMENT, WHICH IS THE SHARPEST COST
 * AND THE EASIEST ONE TO MISS. The two rungs this change was made on are now indistinguishable in
 * every number a run emits: `fired` is 1 for both, `fired_volume` is 1 for both, `fired_burst`
 * measures concentration rather than the rung, and `confidence_bucket_*` — which DID separate them,
 * a lone pair landing in the 10–20 bucket against 20–30 for three or more — now puts both in the
 * same bucket. The count survives only as free text inside each finding's reason. So a future
 * re-shape has to be graded the way this one was, against moderation outcomes joined outside this
 * repository; it cannot be read off the shadow-phase counters. No counter was added here because
 * one would be a new metric key with no consumer, but nobody should discover this by looking for a
 * number that is not there.
 *
 * 🔴 TWO SERIES MOVE ON THE DAY THIS SHIPS, WITH NO ACCOUNT BEHAVING DIFFERENTLY. Read them as the
 * instrument moving, not the population — the same artefact `soleSignalCounters` documents for a
 * registry-size change, in the opposite direction. (a) Every `count == 2` account's confidence rises
 * by exactly +0.125, which for one carrying NO other signal is 0.125 → 0.25, i.e. one
 * `confidence_bucket_*` bucket up; an account that also scores elsewhere can cross TWO bucket edges
 * on the same +0.125, so do not read the shift as uniformly one bucket. (b)
 * `heuristic:asset-staging:sole_signal` INFLATES: the dominance test credits a leader at
 * `leader >= 4 × runnerUp`, and this heuristic's leader score on that population doubled, so the
 * runner-up tolerance doubles with it and accounts that previously counted for nobody now count
 * here. Neither series is comparable across this deploy.
 *
 * The REPORTED POPULATION does not move AT THE SHIPPED CUT — 0.125 already cleared
 * `MIN_REPORTED_CONFIDENCE`, and the production caller passes no override — so for the deployed
 * configuration this is an instrumentation discontinuity and not a detection change. ⚠️ `run.ts`
 * takes `minConfidence` as an option, and for any run configured in the band (0.125, 0.25] it IS a
 * detection change: the whole lone-signal pair population moves from suppressed to reported. A
 * deliberate high-precision grading pass is exactly the run that would sit in that band.
 *
 * 🔴 WHERE THIS CAME FROM, AND WHY NEITHER PREVIOUS VALUE (8, THEN 3) WAS EVIDENCE FOR THE TOP
 * RUNG. The original boundary was calibrated against a predicate this heuristic does not ship: a
 * RATIO test — "all of the account's images are staged" — rather than the unratioed COUNT above.
 * Re-measured against the SHIPPED predicate on a matured cohort (accounts old enough for a
 * moderation outcome to exist, graded against that cohort's own base actioned rate), it moved to 3,
 * which fixed the FIRING POINT and left the ORDERING untouched — nobody had asked which of the two
 * scoring rungs graded better, only whether a pair reached the board at all. Grading the rungs
 * separately is what produced this change: the pair rung graded strongly, and the 3+ rung graded
 * materially worse than it. Those measurements — cohort definition, denominators, per-cell rates
 * and lift — live in the private infra repo and are deliberately not restated here, because this
 * repository is public.
 */
export const STAGED_ZERO_AT = 1;
export const STAGED_ONE_AT = 2;

/**
 * The same two boundaries for the SAME-SECOND half — left where they were when the volume half's
 * top boundary moved down, which is a statement about this arm and not an oversight.
 *
 * `zeroAt: 1` because every staged upload shares its own second with itself, so a burst of one is
 * what a member with any staged image at all has and it must be worth nothing. Two inside one second
 * is the smallest that scores, which is what "created together" means at this resolution.
 *
 * `oneAt: 3` is the cut arithmetic `STAGED_ONE_AT` used to be derived with: a same-second PAIR must
 * clear `LONE_SIGNAL_CUT` on its own, and 3 is the largest integer boundary that does. It was NOT
 * moved alongside the volume boundary, because the finding that moved that one is a statement about
 * staged COUNT rungs and says nothing about same-second concentration. Changing a constant the
 * measurement did not cover, merely to keep two numbers looking alike, would be inventing evidence.
 *
 * 🔴 THE BURST ARM CHANGES NOTHING ABOUT THE SCORE — NOT WHETHER THIS HEURISTIC FIRES, NOT HOW HIGH
 * IT SCORES — AND SAYING SO PLAINLY IS THE POINT. A same-second group is a SUBSET of the staged
 * rows, so `largestSameSecondBurst <= count` ALWAYS: `evidence.ts` builds both from one walk over
 * the same rows, and a row whose timestamp will not parse increments `count` while being left out of
 * the burst tally, which can only widen the gap. The volume ramp now also DOMINATES this one
 * pointwise — same `zeroAt`, smaller `oneAt`, so it is at or above the burst ramp at every input —
 * and `rampScore` is monotonic. Chaining the two: `burst = ramp_b(b) <= ramp_b(count) <=
 * ramp_v(count) = volume`. Hence `max(volume, burst) === volume` identically. Anything implying the
 * burst half independently widens the net would be false.
 *
 * 🔴 THE IDENTITY HOLDS FOR A RANGE OF BURST PAIRS RATHER THAN ONLY FOR THIS ONE — BUT IT IS NOT
 * UNCONDITIONAL, AND THE CONDITION IS THE WHOLE POINT. The volume half is a STEP: 0 at a count of
 * one or less, 1 at two or more. While `BURST_ZERO_AT >= STAGED_ZERO_AT`, a burst needs a count of
 * at least two to score anything, so the volume half is already saturated wherever the burst half is
 * non-zero and `burst > volume` is unreachable. **Drop `BURST_ZERO_AT` to 0 and that fails**: an
 * account with one staged upload has a burst tally of 1, scoring `rampScore(1, 0, 3)` = 0.333 on a
 * burst half against 0 on the volume half, and the arm moves the score again. That is measured
 * rather than reasoned; the figures are on the `max` below, stated once. So the honest statement is
 * CONDITIONAL, and the condition is IMPLIED BY the pointwise-dominance relationship the test named
 * "the volume boundaries stay no wider than the burst ones" pins — not identical to it. That test
 * pins both boundaries; at the shipped step shape only the `zeroAt` half is needed, so it guards
 * something strictly stronger than this paragraph requires.
 *
 * What this DOES cost is the LOOP in the case pinning `score === volume`, which is now `x <= x`
 * over its table and cannot go red for a burst-constant change the way it once did. The guards that
 * replace it are enumerated at the head of that case in `__tests__/heuristics.test.ts` rather than
 * restated here — a coverage ledger kept in two places is the one that goes stale.
 *
 * 🔴 SO IT HAS NO SCORING RATIONALE TODAY, AND NONE IS INVENTED HERE. It previously had one: a
 * tighter boundary pair (4 against 8) expressing "concentration is the stronger of the two claims",
 * which was a real difference in behaviour. Moving the firing point to two consumed that rationale
 * outright, because the volume half now fires everywhere the burst half possibly could, and
 * saturating the volume half at two has since put the identity out of reach of a tighter boundary
 * (the condition and its one exception are two paragraphs up; they are not restated here).
 * The re-measurement does show same-second concentration separating harder than raw volume one count
 * further up — it rests on too few members to author a constant from, so it has not been used, and
 * inventing a gradient the measurement does not support is exactly what this comment exists to
 * prevent. Reviving this arm needs the combination in `score` to stop being a `max` over a DOMINATED
 * operand — which a tighter `BURST_ONE_AT` cannot do, though dropping `BURST_ZERO_AT` below
 * `STAGED_ZERO_AT` can (the paragraph above). "More than a boundary edit" would be too strong: the
 * dominated-ness is what matters, not which kind of edit undoes it.
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
 * this half whatsoever — and no TIGHTENING of `BURST_ONE_AT` can restore it, for the reasons and
 * under the one condition set out on `BURST_ONE_AT`. The counters `run.ts` builds from these two
 * values are therefore the whole of the evidence that will decide whether the arm gets re-shaped or
 * deleted. Read carefully: `burst > 0` here does NOT mean the burst half contributed anything to
 * the account's sub-score.
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
  // and the identity is pinned by the case named "the SCORE is identically the volume half — the
  // burst arm cannot raise it". It is kept rather than collapsed to a bare `volume` because the
  // identity is a property of the two boundary pairs and of the subset relation, not of the model:
  // the moment the DOMINANCE breaks — the burst ramp rising somewhere the volume ramp has not —
  // `max` is the correct combination again and a hardcoded `volume` would silently drop the burst
  // arm. Read it as "the arm is inert, not absent".
  //
  // 🔴 "THE MOMENT THE VOLUME HALF STOPS BEING A STEP" IS THE WRONG TRIGGER, AND THIS COMMENT SAID
  // IT — MEASURED FALSE. At `STAGED_ONE_AT = 3` with its pin updated, i.e. the volume half exactly
  // as un-stepped as it was before this change, `max` and `return volume` fail the SAME 8 cases:
  // zero difference. Un-stepping the volume half does not make the hardcode wrong. Breaking the
  // dominance does (11 against 6; see below). An earlier wording, "the moment either pair moves",
  // was wrong the same way — `BURST_ONE_AT -> 4` moves a pair and leaves `max` and the hardcode
  // still indistinguishable. ⚠️ Read that as a claim about THIS discrimination only: such an edit
  // is not invisible to the suite, it reddens the two assertions that read the burst half at 0.5.
  //
  // 🔴 MEASURED AT TODAY'S CONSTANTS, SO THE CLAIM IS NOT LEFT AS REASONING OR CARRIED OVER FROM AN
  // OLDER ONE: replacing this line with `return volume` leaves this module's suite fully GREEN —
  // 398/398, `vitest run --project 'unit*' src/server/services/bot-account-detection`. Note the
  // denominator is that selection, not the whole app suite. That mutant SURVIVES, and it survives
  // because it is semantically equivalent at these constants, not because the tests are thin —
  // which is the difference this comment exists to record.
  //
  // 🔴 IT IS STILL KILLABLE BY A BURST BOUNDARY, AND AN EARLIER VERSION OF THIS COMMENT SAID
  // OTHERWISE. Measured at `BURST_ZERO_AT = 0` WITH ITS LITERAL PIN UPDATED IN THE SAME EDIT — the
  // condition is load-bearing, because a bare constant edit also fails the pin and gives 12/7
  // instead — this module's suite fails 11 cases against this `max` and 6 against the mutant. Two
  // different numbers either way, so the control that proves this guard reachable still exists.
  // What DID narrow is which boundary works: while the burst pair stays no steeper than the volume
  // pair (see `BURST_ONE_AT`), the two are semantically identical and the mutant survives, so a
  // tighter `BURST_ONE_AT` alone no longer separates them. Nothing here should be read as claiming
  // the burst arm is covered by the score at the shipped constants.
  //
  // ⚠️ ALL FOUR NUMBERS ABOVE ARE SUITE-SIZE-DEPENDENT AND HAVE GONE STALE ONCE ALREADY, inside the
  // change that wrote them: deleting one redundant case moved the `max` column by one and left the
  // mutant column alone, because that case failed under `max` and passed under the mutant. Re-run
  // the four arms rather than adjusting them by hand — the claim that matters is that the two
  // columns DIFFER, not the literals.
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
    // 🔴 THE VERBS AGREE WITH `facts.count`, NOT WITH THE TOTAL BESIDE IT. "1 of this account's 12
    // uploaded images carry no generation metadata" is the shape a naive plural gets wrong: the
    // subject of the sentence is the STAGED count, and the total is only the denominator it is
    // measured against. Two staged uploads is the firing point, so `count === 1` is not reachable
    // through the heuristic today — this is written to agree anyway, because `explain` is a pure
    // function anyone may call and a boundary that moves must not leave a grammar bug behind it.
    const clauses = [
      `${facts.count} of this account's ${member.posts.all.images} uploaded ` +
        `${plural(member.posts.all.images, 'image')} ${plural(facts.count, 'carries', 'carry')} ` +
        `no generation metadata and ${plural(facts.count, 'is', 'are')} attached to no post`,
    ];
    if (burst > 0)
      clauses.push(
        `${facts.largestSameSecondBurst} of them ` +
          `${plural(facts.largestSameSecondBurst, 'was', 'were')} created within the same second`
      );
    return clauses.join('; ');
  },
};
