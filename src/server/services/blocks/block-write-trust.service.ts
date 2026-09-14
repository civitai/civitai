import { TRPCError } from '@trpc/server';
import { OnboardingSteps } from '~/server/common/enums';
import type { SessionUser } from '~/types/session';
import { Flags } from '~/shared/utils/flags';

/**
 * THE min-trust gate for App Blocks surfaces where a block writes something OTHER
 * USERS SEE, on the viewer's behalf.
 *
 * 🔴 WHY IT LIVES HERE RATHER THAN IN `apps-shared.router.ts`, WHERE IT WAS BORN.
 * It now has two callers on two different routers (`apps-shared`'s shared-storage
 * writes and `blocks`' `createPostFromApp`), and a trust predicate open-coded at
 * two sites is a predicate that will be wrong at one of them. Router-to-router
 * imports are also how import cycles start. So the rule lives in one module and
 * BOTH routers import it from here. `apps-shared.router.ts` does NOT re-export it
 * — its importers were enumerated when the predicate moved and none of them took
 * it from there, so re-exporting would only have preserved a second name for the
 * same rule. (That file's own note at the former call site says the same; this
 * line used to claim the opposite and was the stale half of the pair.) The move
 * is a relocation, not a rewrite: the signals, their order and their exact deny
 * messages are byte-identical to the original, which is what keeps the
 * shared-storage tests meaningful.
 *
 * Reuses EXISTING civitai trust signals hydrated from `SessionUser` — no new trust
 * score. FAIL-CLOSED: a vanished subject (null), banned, muted,
 * onboarding-incomplete, unverified-AND-no-OAuth, or too-new account is DENIED.
 * `asserts` narrows `user` to non-null for the caller.
 *
 * "Verified email" is satisfied by `emailVerified` OR a linked OAuth account
 * (`hasLinkedOAuth`, a row in the `Account` table). Rationale: civitai's
 * `emailVerified` is only ever set by the email-CHANGE flow — OAuth sign-in
 * (GitHub/Google/Discord, ~69% of active users) never sets it, so the raw check
 * locked out most legitimate users. A linked OAuth account is a provider-verified
 * identity and a STRONGER anti-sybil signal than an unverified civitai email
 * (minting N GitHub/Google accounts is harder than N unverified civitai accounts).
 * A user with NEITHER a verified email NOR an OAuth link genuinely still needs to
 * verify, so that case keeps the original deny.
 *
 * Signals (all AND-ed):
 *   sub!=anon (caller passes non-null) · !bannedAt · !muted ·
 *   onboarding-complete (Flags.hasFlag(onboarding, Buzz)) ·
 *   (emailVerified present OR hasLinkedOAuth) ·
 *   account age ≥ MIN_ACCOUNT_AGE_MS · [optional] paid tier.
 *
 * ⚠️ IT IS NOT A TIER SYSTEM. The `unverified` / `verified` / `internal` enum is
 * `AppBlock.trustTier` — a different axis, about the APP's iframe sandbox flags.
 * This is about the HUMAN.
 */

// ── Min-trust gate (design H3 / MIN-TRUST GATE) ───────────────────────────────
// Account must be older than this to write/vote (anti-sybil). Starts at 7d.
export const MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Flag-toggleable STRONG anti-sybil lever (design H5): require a paid tier to
// write/vote. OFF by default — flip to true (or wire to a flag) if sybil pressure
// materializes. `free`/absent tier fails when on.
export const REQUIRE_PAID_TIER = false;

export function assertSharedWriteTrust(
  user: SessionUser | null,
  hasLinkedOAuth: boolean
): asserts user is SessionUser {
  const deny = (message: string): never => {
    throw new TRPCError({ code: 'FORBIDDEN', message });
  };
  if (!user) return deny('Your account is not eligible for this action');
  if (user.bannedAt) return deny('Your account is not eligible for this action');
  if (user.muted) return deny('Your account has been restricted');
  if (!Flags.hasFlag(user.onboarding ?? 0, OnboardingSteps.Buzz)) {
    return deny('Complete onboarding before contributing');
  }
  if (!user.emailVerified && !hasLinkedOAuth) {
    return deny('Verify your email before contributing');
  }
  const createdAt = user.createdAt ? new Date(user.createdAt).getTime() : NaN;
  if (!Number.isFinite(createdAt) || Date.now() - createdAt < MIN_ACCOUNT_AGE_MS) {
    return deny('Your account is too new to contribute');
  }
  if (REQUIRE_PAID_TIER && (!user.tier || user.tier === 'free')) {
    return deny('A membership is required to contribute');
  }
}
