import type { DefaultSession } from 'next-auth';
import { UserTier } from '~/server/schema/user.schema';

interface ExtendedUser {
  id: number;
  showNsfw: boolean;
  blurNsfw: boolean; // client only
  username: string;
  browsingLevel: number;
  onboarding: number;
  image?: string;
  email?: string;
  emailVerified?: Date;
  createdAt?: Date;
  isModerator?: boolean;
  customerId?: string; // could be fetched
  subscriptionId?: string; // could be fetched
  tier?: UserTier;
  muted?: boolean;
  bannedAt?: Date;
  autoplayGifs?: boolean; // client only - could be cookie setting
  permissions?: string[];
  filePreferences?: UserFilePreferences;
  leaderboardShowcase?: string; // client only
  referral?: { id: number }; // client only

  // TODO.briant - clean up user session data
  /*
    remove `deletedAt` from session user data
    remove `emailVerified`, update user account page to make call to get current user data
   */
}

declare module 'next-auth' {
  interface DefaultUser extends ExtendedUser {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  }

  interface SessionUser extends ExtendedUser, DefaultSession['user'] {}
  /**
   * Returned by `useSession`, `getSession` and received as a prop on the `SessionProvider` React Context
   */
  interface Session {
    user?: ExtendedUser & DefaultSession['user'];
    error?: string;
  }
}
