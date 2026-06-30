// The session-token CONTRACT — the stable surface spokes read. This is the one part
// of the package whose *shape* changes force a coordinated consumer update (parent
// docs §"what still forces a lockstep deploy"), so keep changes additive.
//
// DRAFT NOTE: `SessionUser` here is a vendored mirror of the ExtendedUser interface in
// src/types/next-auth.d.ts. App-specific field types (UserTier, UserMeta,
// UserSubscriptionsByBuzzType, banDetails) are loosened to placeholders so the package
// compiles in isolation — when wired up, point these at @civitai/db-schema (or a future
// @civitai/schema) rather than re-importing `~/server/schema/user.schema`.

export interface SessionUser {
  id: number;
  username?: string;
  email?: string;
  emailVerified?: Date;
  image?: string;
  createdAt?: Date;
  isModerator?: boolean;
  muted?: boolean;
  mutedAt?: Date;
  bannedAt?: Date;
  deletedAt?: Date;
  showNsfw: boolean;
  blurNsfw: boolean;
  browsingLevel: number;
  redBrowsingLevel?: number;
  onboarding: number;
  permissions?: string[];
  /** App-namespaced role grants (`app:role`), e.g. `["moderator:volunteer", "tester"]`. Read via `appRoles`. */
  roles?: string[];
  customerId?: string;
  paddleCustomerId?: string;
  subscriptionId?: string;
  memberInBadState?: boolean;
  allowAds?: boolean;
  // Client-only fields (parity with the main app's ExtendedUser — see src/types/next-auth.d.ts).
  name?: string;
  autoplayGifs?: boolean;
  leaderboardShowcase?: string;
  referral?: { id: number };
  // app-specific — tighten against the schema package when wiring up:
  tier?: string;
  meta?: Record<string, unknown>;
  banDetails?: Record<string, unknown>;
  subscriptions?: Record<string, unknown>;
  filePreferences?: Record<string, unknown>;
}

/** The decoded JWT payload (thin civ-token, or a decoded legacy next-auth cookie). The rest are JWT fields. */
export interface SessionClaims {
  sub?: string;
  /** Standard JWS token id — the session id (single-session logout). */
  jti?: string;
  /** epoch ms the token was (re)signed — existing `token.signedAt`. */
  signedAt?: number;
  /**
   * Moderator impersonation: the moderator's userId, stamped into the impersonated user's session token (the
   * hub mints it on a mod-authed impersonate call). Present ⇒ this is an impersonation session; the exit path
   * reads it to re-mint the moderator's own session. Identity-only — no extra credential. See cutover (F).
   */
  impersonatedBy?: number;
  /**
   * id ONLY. The thin civ-token carries identity in `sub`; a decoded LEGACY next-auth cookie (the only place
   * `user` is populated) embedded a full enriched user, but it is STALE — captured at login — so we deliberately
   * narrow the type to `{ id }`. Every consumer resolves the rich, current user FRESH by id/sub
   * (getSessionUserById / getOrProduceSessionUser); reading e.g. `claims.user.tier` off the token must stay a
   * compile error, not a stale-data footgun.
   */
  user?: { id?: number | string };
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
}
