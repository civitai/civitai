import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface DefaultUser {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
    showNsfw: boolean;
    blurNsfw: boolean;
    username?: string;
  }
  /**
   * Returned by `useSession`, `getSession` and received as a prop on the `SessionProvider` React Context
   */
  interface Session {
    user?: {
      id: number;
      showNsfw: boolean;
      blurNsfw: boolean;
      username?: string;
    } & DefaultSession['user'];
  }
}
