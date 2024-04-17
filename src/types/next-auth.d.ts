import type { User as PrismaUser } from '@prisma/client';
import { DefaultSession, DefaultUser } from 'next-auth';
import { UserTier } from '~/server/schema/user.schema';

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
  subscriptionId?: string; // could be fetched
  tier?: UserTier;
  muted?: boolean;
  bannedAt?: Date;
  autoplayGifs?: boolean; // client only - could be cookie setting
  permissions?: string[];
  filePreferences?: UserFilePreferences;
  leaderboardShowcase?: string; // client only
  referral?: { id: number }; // client only
  memberInBadState?: boolean;
  // TODO.briant - clean up user session data
  /*
    remove `deletedAt` from session user data
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
  }
}
