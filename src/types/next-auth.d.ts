import type { DefaultSession, DefaultUser } from 'next-auth';
import type { UserTier } from '~/server/schema/user.schema';
import type { User as PrismaUser } from '~/shared/utils/prisma/enums';
import type { getUserBanDetails } from '~/utils/user-helpers';

interface ExtendedUser {
  id: number;
  showNsfw: boolean;
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
  subscriptionId?: string; // could be fetched
  tier?: UserTier;
  muted?: boolean;
  bannedAt?: Date;
  permissions?: string[];
  referral?: { id: number }; // client only
  meta?: UserMeta;
  banDetails?: ReturnType<typeof getUserBanDetails>;
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

interface TokenUser {
  id: number;
  username: string;
  isModerator?: boolean;
}
