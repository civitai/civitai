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
 * WHERE AUDIENCE TARGETING GOES (deliberately not here yet): add an optional
 * `audience` field to `FeatureNotice` below and branch on it inside
 * `useFeatureNotice`'s returned `isDismissed`/visibility. It is omitted today
 * because nothing reads it — an unread field on a definition looks like a gate
 * and gates nothing. The early-adopter session flag it would consume is being
 * added separately; wiring the two together is a follow-up.
 */

export type FeatureNotice = {
  /**
   * The string persisted into `User.settings.dismissedAlerts`.
   * 🔴 Production data — see the file header before touching one.
   */
  readonly id: string;
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
  /** Inline explainer at the top of a remix gallery. */
  remixGalleryExplainer: { id: 'remix-gallery-explainer' },
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
