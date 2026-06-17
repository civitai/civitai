import type {
  UserTier,
  UserSubscriptionsByBuzzType,
  UserMeta,
} from '~/server/schema/user.schema';
import type { getUserBanDetails } from '~/utils/user-helpers';

// First-party session types — the app imports `Session`/`SessionUser` from here (not from 'next-auth'), so the
// types don't depend on the next-auth package (now fully removed). `UserFilePreferences` is an ambient global
// (global.d.ts).

/** The rich user attached to a session (was next-auth's augmented `SessionUser`/`ExtendedUser`). */
export interface SessionUser {
  id: number;
  showNsfw: boolean;
  blurNsfw: boolean; // client only
  browsingLevel: number;
  onboarding: number;
  username?: string;
  image?: string;
  email?: string;
  emailVerified?: Date;
  createdAt?: Date;
  isModerator?: boolean;
  customerId?: string; // could be fetched
  paddleCustomerId?: string; // could be fetched
  subscriptionId?: string; // deprecated, kept for backward compatibility
  tier?: UserTier; // highest tier across all subscriptions
  muted?: boolean;
  mutedAt?: Date;
  bannedAt?: Date;
  autoplayGifs?: boolean; // client only - could be cookie setting
  permissions?: string[];
  filePreferences?: UserFilePreferences;
  leaderboardShowcase?: string; // client only
  referral?: { id: number }; // client only
  memberInBadState?: boolean;
  meta?: UserMeta;
  allowAds?: boolean;
  banDetails?: ReturnType<typeof getUserBanDetails>;
  redBrowsingLevel?: number;
  deletedAt?: Date;
  subscriptions?: UserSubscriptionsByBuzzType; // multi-subscription support per buzzType
  name?: string | null; // from next-auth's DefaultSession['user']
}

/** Returned by `getServerAuthSession` + the first-party `useSession`. */
export interface Session {
  user?: SessionUser;
  /** Synthesized by GET /api/auth/session (the thin hub session has no client-visible expiry). */
  expires?: string;
  error?: string;
  needsCookieRefresh?: boolean;
  /** Moderator impersonation (F): the moderator's id when this session is impersonating someone. */
  impersonatedBy?: number;
}
