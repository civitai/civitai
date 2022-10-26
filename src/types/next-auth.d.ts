import { DefaultSession } from 'next-auth';

interface ExtendedUser {
  id: number;
  showNsfw: boolean;
  blurNsfw: boolean;
  username?: string;
}

declare module 'next-auth' {
  interface DefaultUser extends ExtendedUser {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  }
  /**
   * Returned by `useSession`, `getSession` and received as a prop on the `SessionProvider` React Context
   */
  interface Session {
    user?: ExtendedUser & DefaultSession['user'];
  }
}
