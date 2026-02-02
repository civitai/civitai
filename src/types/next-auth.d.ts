import type { DefaultSession, DefaultUser } from 'next-auth';
import type { UserTier, UserSubscriptionsByBuzzType } from '~/server/schema/user.schema';
import type { User as PrismaUser } from '~/shared/utils/prisma/enums';
import type { getUserBanDetails } from '~/utils/user-helpers';

interface ExtendedUser {
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
  subscriptionId?: string; // could be fetched - deprecated, kept for backward compatibility
  tier?: UserTier; // Highest tier across all subscriptions
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
  // Multi-subscription support per buzzType
  subscriptions?: UserSubscriptionsByBuzzType;
  // TODO.briant - clean up user session data
  /*
    remove `emailVerified`, update user account page to make call to get current user data
   */
}

declare module 'next-auth' {
  interface User extends ExtendedUser, Omit<DefaultUser, 'id'> {
    id: PrismaUser['id'];
  }

  interface SessionUser extends ExtendedUser, DefaultSession['user'] {}

  /**
   * Returned by `useSession`, `getSession` and received as a prop on the `SessionProvider` React Context
   */
  interface Session {
    user?: ExtendedUser & DefaultSession['user'];
    error?: string;
    needsCookieRefresh?: boolean;
  }
}

interface TokenUser {
  id: number;
  username: string;
  isModerator?: boolean;
}
