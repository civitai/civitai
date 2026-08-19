/**
 * The registry of in-product feature notices.
 *
 * A "notice" is a one-off, per-user, server-persisted nudge: shown until the
 * user dismisses it, and then never again on any device. Dismissal lives in
 * `User.settings.dismissedAlerts` (see `dismissAlertHandler`), which is what
 * distinguishes a notice from `DismissibleAlert`'s `localStorage` behaviour —
 * a notice explains a FEATURE, so someone who has read it should not meet it
 * again on their phone.
 *
 * Before this file each notice declared a loose `const ALERT_ID = '…'` beside
 * its component. Seven files did that, and the copies had drifted from each
 * other in four separate ways (recorded in the PR that introduced this file).
 * Declaring them here is what makes the set enumerable — which is also what a
 * future "announce this flag" surface needs to iterate over.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 EVERY `id` BELOW IS PRODUCTION DATA.
 *
 * These exact strings are already stored in real users' `dismissedAlerts`
 * arrays. Changing one does not rename anything — it mints a NEW notice and
 * re-shows the old one to every user who had already dismissed it. Treat an id
 * change as a data migration with an explicit decision behind it, never as a
 * refactor. `notice-registry.test.ts` pins each one as a literal for that
 * reason.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * AUDIENCE TARGETING (the follow-up this header used to describe as pending, now
 * built). A notice may name the feature flag it announces via `audience`, and
 * `useFeatureNotice` returns `isInAudience` off it. The rule the header laid
 * down still holds and is what the tests enforce: the field is READ, and it
 * changes what renders. `isNoticeAudienceMatched` below is that read, and
 * `useFeatureNotice.audience.test.ts` asserts the hook's returned value moves
 * with it rather than asserting the field exists.
 */

import type { FeatureFlagKey } from '~/server/services/feature-flags.service';

/**
 * Who a notice is FOR — as opposed to who can see the feature it describes.
 *
 * Deliberately a resolved feature-flag key rather than a cohort name or a
 * naming convention. Two properties come out of that choice:
 *
 * 1. "Is this flag worth announcing?" is a LOOKUP in this file, so it is
 *    reviewed like any other code change. A convention ("anything targeting the
 *    early-adopter cohort is announceable") would conflate *who can see a
 *    feature* with *who should be told about it*, and leave no way to roll out
 *    quietly to that cohort — which is most of what a staged cohort is for.
 * 2. The value is read through `useOptionalFeatureFlags`, i.e. whatever
 *    `FeatureFlagsProvider` resolved for THIS session. Never a keyed
 *    evaluation, which has no context and so silently answers "not in the
 *    segment" for everyone.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHICH PATH A FLAG ARRIVES ON — read this before adding a second audience.
 *
 * `FeatureFlagsProvider` hands consumers `{ ...ssrFlags, ...toggleableOverlay }`.
 * BOTH halves are computed server-side from the caller's real session, so a
 * segment-scoped flag can match on either; which one carries a given flag is
 * decided solely by whether its definition in `feature-flags.service.ts` sets
 * `toggleable: true`:
 *
 * - NOT `toggleable` (the `flags` prop, seeded at SSR by `getFeatureFlagsAsync`
 *   → `_app`). Resolved once per request against the user's identity, tier,
 *   cohort, host and region, INCLUDING Flipt segment evaluation, and present
 *   from the first client frame. `remixGallery` — the only flag any notice
 *   names today — is this kind: `{ availability: ['mod'], fliptKey:
 *   'remix-gallery' }`, no `toggleable`.
 * - `toggleable: true` (the `userFlags` overlay, from `user.getFeatureFlags` /
 *   `computeUserFeatureFlagsOverlay`). The user's own on/off CHOICE, layered
 *   over the SSR flags. `computeUserFeatureFlagsOverlay` filters to toggleable
 *   keys, so a non-toggleable flag never appears in it at all.
 *
 * The consequence worth knowing, because it is invisible from here: for a
 * non-toggleable flag the `flagsReady` guard in `isNoticeAudienceMatched` can
 * DEFER a render but cannot change its answer — the SSR flags already hold the
 * per-user verdict and the overlay resolving does not revise it. So today, for
 * the one notice that ships, that guard costs at most a frame and buys nothing.
 * It becomes load-bearing the moment a notice names a `toggleable` flag, which
 * is the case it was written for. It is deliberately not deleted for that
 * reason — but do not read the shipped notice as evidence that it works.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export type NoticeAudience = {
  /**
   * The flag whose holders should be told. The notice renders only for a user
   * this flag is ON for, as resolved for their own session.
   */
  readonly feature: FeatureFlagKey;
};

export type FeatureNotice = {
  /**
   * The string persisted into `User.settings.dismissedAlerts`.
   * 🔴 Production data — see the file header before touching one.
   */
  readonly id: string;
  /**
   * Optional. Omitted means "everyone who reaches the call site" — the
   * behaviour every notice had before targeting existed, and still has.
   */
  readonly audience?: NoticeAudience;
};

export const FEATURE_NOTICES = {
  /** Sub-nav popover pointing at the settings toggle for the tidied-away tabs. */
  navTidy: { id: 'nav-tidy-notice' },
  /** Header popover telling holders of yellow buzz where their balance went. */
  yellowBuzzMigration: { id: 'yellow-buzz-migration' },
  /** Crypto-deposit onboarding card. The only notice a user can bring back. */
  cryptoOnrampGuidance: { id: 'crypto-onramp-guidance' },
  /** Blue-buzz rewards banner inside the buy-buzz modal. */
  earnBlueBuzzRewards: { id: 'earn-blue-buzz-rewards' },
  /**
   * Inline explainer at the top of a remix gallery.
   *
   * The first targeted notice. The remix gallery is a staged rollout — a
   * feature a user could not previously see — so the explainer announcing it is
   * only ever news to someone the `remixGallery` flag is on for.
   *
   * Its mount site gates on the same flag today, so in production this is
   * defence in depth rather than a change in who sees it. What it buys is that
   * the gate now travels with the NOTICE instead of living in one parent: a
   * second mount site cannot forget it, because the hook applies it.
   */
  remixGalleryExplainer: {
    id: 'remix-gallery-explainer',
    audience: { feature: 'remixGallery' },
  },
  /** Referral dashboard (lite): the 3-card onboarding stepper. */
  referralLiteOnboarding: { id: 'referral-lite-onboarding' },
  /**
   * Referral kickback explainer. Deliberately ONE id shared by the lite and
   * full dashboards — dismissing it on either must dismiss it on both. That was
   * previously two identical string literals in two files, one keystroke away
   * from silently becoming two different notices.
   */
  referralKickback: { id: 'referral-kickback-info' },
  /** Referral dashboard (full): the "How it works" card. */
  referralHowItWorks: { id: 'referral-how-it-works' },
  /** Referral dashboard (full): the token-shop explainer. */
  referralTokenShop: { id: 'referral-token-shop-info' },
} as const satisfies Record<string, FeatureNotice>;

export type FeatureNoticeKey = keyof typeof FEATURE_NOTICES;

/** Every registered id. Exported so the registry can be checked as a whole. */
export const FEATURE_NOTICE_IDS: readonly string[] = Object.values(FEATURE_NOTICES).map(
  (n) => n.id
);

/**
 * Is this notice dismissed, given the user's stored `dismissedAlerts`?
 *
 * `dismissedAlerts` is `undefined` in two different situations and this returns
 * `false` for both: the settings query has not resolved yet, and the user has
 * simply never dismissed anything. They are indistinguishable from here, so a
 * caller that must not render against an unresolved settings object has to gate
 * on `hasSettings` from `useFeatureNotice` as well — "not dismissed" is not the
 * same claim as "known not to be dismissed".
 */
export function isNoticeDismissed(
  dismissedAlerts: readonly string[] | undefined,
  notice: FeatureNotice
): boolean {
  return (dismissedAlerts ?? []).includes(notice.id);
}

/**
 * Is this user in the notice's audience?
 *
 * `true` for every notice with no `audience` — that is the pre-targeting
 * behaviour, and it must stay exactly that for the eight untargeted notices.
 *
 * For a targeted notice this FAILS CLOSED in both of the ways it can be unsure,
 * because the cost of the two errors is not symmetric: not announcing a feature
 * to someone who has it is a missed nudge, announcing one to someone who does
 * not have it is a broken promise.
 *
 * - `flagsReady` false → the toggleable overlay query has not settled, so a
 *   toggleable flag's value is still whatever the SSR snapshot defaulted it to.
 *   Reading it would announce against defaults and then retract, which is the
 *   flash the notice machinery exists to avoid.
 * - `flags` null → rendered outside the flag provider, so there is no answer at
 *   all. Treat that as "not in the audience" rather than as "no gate".
 *
 * 🔴 `flagsReady` IS NOT A CLAIM THAT THE FLAGS ARE THIS USER'S. It is
 * `!session.data || isSuccess || isError` (see `FeatureFlagsProvider`), and it
 * is `true` in two states where the overlay is NOT the user's:
 *
 * - the `isError` arm — the overlay query FAILED (`retry: 0`), `userFeatures`
 *   falls back to `{}`, and the merged flags are host-level SSR only;
 * - logged out — no session, so `ready` is true against the anonymous snapshot.
 *
 * Both are harmless for a NON-toggleable flag, whose SSR value is already the
 * per-user verdict. For a toggleable one they mean this function can be handed
 * a default and told it is resolved, i.e. it FAILS OPEN in exactly the case the
 * `flagsReady` argument exists to close. Anyone giving a notice a `toggleable`
 * audience has to close that here — the anon half is already closed one level
 * up, where `useFeatureNotice` ANDs in `!!currentUser`.
 *
 * @param flags      The provider's resolved flags (SSR flags + toggleable
 *                   overlay), or null outside a provider.
 * @param flagsReady Whether the toggleable overlay query has SETTLED — success,
 *                   error, or no session at all. See the warning above: this is
 *                   weaker than "the overlay is the user's".
 */
export function isNoticeAudienceMatched(
  notice: FeatureNotice,
  flags: Partial<Record<FeatureFlagKey, boolean>> | null | undefined,
  flagsReady: boolean
): boolean {
  const { audience } = notice;
  if (!audience) return true;
  if (!flagsReady) return false;
  return flags?.[audience.feature] === true;
}
