import { describe, expect, it } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

/**
 * A Flipt segment constraint reads one of two inputs, and which one is decided by the constraint's
 * TYPE, not by the flag:
 *
 * - `ENTITY_ID_COMPARISON_TYPE` matches the `entityId` ARGUMENT.
 * - `STRING_COMPARISON_TYPE` matches a named property of the CONTEXT argument.
 *
 * Measured against flipt-state's `civitai-app/default/features.yaml`: of the 15 segments defined
 * there, 12 are built from `STRING_COMPARISON_TYPE` constraints — every identity, tier and cohort
 * segment we have (`moderators`, `testers`, `early-adopters`, `members`, `app-dev-testers`,
 * `license-fee-tester`, `CreatorProgram`, …). Only three (`is-zach`, `is-koen`, `is-debuggador`) read
 * the entityId.
 *
 * So an evaluation that names a subject in `entityId` and passes NO context can match `all-users`
 * and those three, and nothing else. For every other segment it returns the flag's base `enabled`
 * value — indistinguishable from an honest "this subject is not in the segment". No error, no log
 * line, no way to tell the two apart from the outside. It has cost this repo twice: the feedback
 * gate (#4042) and `resolveTestingAccess`, whose `testers` rollout was structurally unreachable for
 * every non-moderator.
 *
 * The tests below pin that mechanism against the live segment shapes, so the claim stays true as
 * `buildFliptContext` changes.
 *
 * 🔴 WHAT USED TO BE HERE, AND WHY IT IS NOT — read this before adding it back.
 *
 * The first half of this file was a SOURCE GATE: it walked `src/`, found every Flipt evaluation,
 * and failed if one passed an `entityId` with no context unless the site was listed in a hand-typed
 * ledger. **Justin removed it deliberately on 2026-09-09** (ClickUp 868kwa4w4), on this evidence:
 *
 * - In the three weeks it existed, it caught NOTHING. `git log -S"ENTITY_WITHOUT_CONTEXT_LEDGER"`
 *   over its own file returns zero commits, so no one ever had to ledger a new violation.
 * - It cost ~20 renumberings of its own rows, at least two PRs going CONFLICTING (and a conflicted
 *   PR gets no CI in this repo, so they were unverifiable rather than merely unmergeable), and one
 *   full unit suite going red in a file the diff never touched. The ledger was keyed on `file:line`,
 *   so any two PRs touching `image.service.ts` collided in it for no informational reason.
 *
 * A PR to make the gate cheap (#4726, keyed on file+flag with the sites named) was closed unmerged
 * in favour of this. The trade accepted: the defect class above is now caught by review and by the
 * behavioural tests below, not by a scan — so a NEW context-less evaluation ships silently.
 *
 * If you are about to re-add a source gate here, that is a reversal of a decision made with numbers,
 * not an oversight being corrected. Bring numbers.
 */

describe('flipt evaluation context — what a missing context costs', () => {
  const EARLY_ADOPTER_ID = 8123;
  const PLAIN_ID = 4471;

  const sessionUser = (over: Partial<SessionUser> = {}): SessionUser =>
    ({
      id: PLAIN_ID,
      isModerator: false,
      muted: false,
      onboarding: OnboardingSteps.Buzz,
      isEarlyAdopter: false,
      ...over,
    } as SessionUser);

  /** `early-adopters`: ALL_MATCH over `isEarlyAdopter eq "true"`. */
  const earlyAdopters = (ctx: Record<string, string>) => ctx.isEarlyAdopter === 'true';
  /** `moderators`: ALL_MATCH over `isModerator eq "true"`. */
  const moderators = (ctx: Record<string, string>) => ctx.isModerator === 'true';
  /** `app-dev-testers`: ANY_MATCH over `userId isoneof [...]`. */
  const idListed = (ids: string[]) => (ctx: Record<string, string>) => ids.includes(ctx.userId);
  /** `members`: ANY_MATCH over `isMember eq "true"` OR `isModerator eq "true"`. */
  const members = (ctx: Record<string, string>) =>
    ctx.isMember === 'true' || ctx.isModerator === 'true';

  it('an EMPTY context matches none of the live property segments', () => {
    // This is the whole defect in one line: the entityId is not on offer to any
    // of these, so a context-less evaluation is a uniform miss.
    const empty: Record<string, string> = {};
    expect(earlyAdopters(empty)).toBe(false);
    expect(moderators(empty)).toBe(false);
    expect(members(empty)).toBe(false);
    expect(idListed([String(EARLY_ADOPTER_ID), String(PLAIN_ID)])(empty)).toBe(false);
  });

  it('buildFliptContext emits the properties those segments read', () => {
    const ctx = buildFliptContext(sessionUser({ id: EARLY_ADOPTER_ID, isEarlyAdopter: true }));
    // Hand-typed against the segment constraints, not read back off the helper.
    expect(ctx.isEarlyAdopter).toBe('true');
    expect(ctx.userId).toBe(String(EARLY_ADOPTER_ID));
    expect(ctx.isModerator).toBe('false');
    expect(ctx.isMember).toBe('false');
    expect(ctx.isInCreatorProgram).toBe('false');
    expect(ctx.isLoggedIn).toBe('true');
    expect(ctx.tier).toBe('free');
  });

  it('the same subject matches early-adopters WITH a context and misses WITHOUT one', () => {
    const user = sessionUser({ id: EARLY_ADOPTER_ID, isEarlyAdopter: true });
    // The only thing that changes between the two arms is whether the context is
    // handed over — same user, same segment, opposite answers.
    expect(earlyAdopters(buildFliptContext(user))).toBe(true);
    expect(earlyAdopters({})).toBe(false);
  });

  it('a context is not a rubber stamp — a non-member still misses', () => {
    // The negative control on the case above. Without it, "with a context it
    // matches" would also be satisfied by a predicate wired to true.
    expect(earlyAdopters(buildFliptContext(sessionUser({ isEarlyAdopter: false })))).toBe(false);
    expect(moderators(buildFliptContext(sessionUser({ isModerator: false })))).toBe(false);
    expect(members(buildFliptContext(sessionUser({ tier: 'free' })))).toBe(false);
  });

  it('a userId-list segment reads the CONTEXT property, so the entityId cannot serve it', () => {
    const user = sessionUser({ id: PLAIN_ID });
    const segment = idListed([String(PLAIN_ID)]);
    expect(segment(buildFliptContext(user))).toBe(true);
    // The defect shape: the id was passed, just not where the constraint looks.
    expect(segment({ isModerator: 'false' })).toBe(false);
  });

  it('an anonymous context is a real answer, not an empty one', () => {
    const ctx = buildFliptContext(undefined);
    expect(ctx.isLoggedIn).toBe('false');
    expect(ctx.userId).toBeUndefined();
    expect(earlyAdopters(ctx)).toBe(false);
  });

  it('a tiered user is a member and a moderator is one too', () => {
    expect(members(buildFliptContext(sessionUser({ tier: 'bronze' })))).toBe(true);
    expect(members(buildFliptContext(sessionUser({ isModerator: true })))).toBe(true);
  });
});
