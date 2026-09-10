import { describe, expect, it } from 'vitest';
import { OnboardingComplete, OnboardingSteps } from '~/server/common/enums';
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
 * The tests below pin what `buildFliptContext` (`~/server/services/feature-flags.service`) emits,
 * against a model of those segments HAND-COPIED from flipt-state on 2026-08-20. Nothing here
 * reads flipt-state, so a segment that changes shape upstream drifts from this file silently.
 *
 * 🔴 A source gate that scanned every call site for this used to live here. It was removed
 * deliberately on 2026-09-09 (PR #4735) after catching nothing in three weeks, at a cost in merge
 * conflicts. Re-adding one is a reversal of a decision made with numbers, not an oversight being
 * corrected — and a cheaper file+flag-keyed version was already built and closed unmerged
 * (#4726), so proposing that is not new either. Bring numbers.
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

  // The one property this app adds on top of the shared `@civitai/flipt/context` builder, and the
  // only one no package test can cover.
  //
  // 🔴 THREE ARMS, AND THE FIRST ONE IS WHY. A real member's `onboarding` carries the completion
  // bits too (`OnboardingComplete` is 15, so a member reads 31) — so an arm that sets the
  // CreatorProgram bit ALONE cannot tell `hasFlag` from `===`, and `===` returns false for every
  // real member. That is the segment going dark for 100% of the people it targets, with no error
  // and no log line.
  it('reads isInCreatorProgram off the onboarding BIT, not the whole value', () => {
    const withProgram = OnboardingComplete | OnboardingSteps.CreatorProgram;
    expect(buildFliptContext(sessionUser({ onboarding: withProgram })).isInCreatorProgram).toBe(
      'true'
    );
    // Other bits set, this one not: kills a mutant that reads any onboarding progress as membership.
    expect(
      buildFliptContext(sessionUser({ onboarding: OnboardingComplete })).isInCreatorProgram
    ).toBe('false');
    expect(buildFliptContext(sessionUser()).isInCreatorProgram).toBe('false');
    // A HIGHER bit set without this one — someone banned from the program. Kills a `>=` mutant,
    // which the three arms above cannot see, and which would read every banned user as a member.
    expect(
      buildFliptContext(
        sessionUser({ onboarding: OnboardingComplete | OnboardingSteps.BannedCreatorProgram })
      ).isInCreatorProgram
    ).toBe('false');
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

  it('a userId-list segment reads context.userId, so a context without it misses', () => {
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
