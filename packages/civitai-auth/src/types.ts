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

/** The decoded JWT payload. `user` is the SessionUser; the rest are next-auth/JWT fields. */
export interface SessionClaims {
  sub?: string;
  /** Standard JWS token id — the session id (single-session logout). */
  jti?: string;
  /** epoch ms the token was (re)signed — existing `token.signedAt`. */
  signedAt?: number;
  user?: SessionUser;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
}
