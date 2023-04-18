import { PrismaAdapter } from '@next-auth/prisma-adapter';
import { User } from '@prisma/client';
import NextAuth, { Session, type NextAuthOptions } from 'next-auth';
import DiscordProvider from 'next-auth/providers/discord';
import GithubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';
import RedditProvider from 'next-auth/providers/reddit';
import EmailProvider from 'next-auth/providers/email';

import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { getRandomInt } from '~/utils/number-helpers';
import { sendVerificationRequest } from '~/server/auth/verificationEmail';
import { refreshToken, invalidateSession } from '~/server/utils/session-helpers';
import { getSessionUser, updateAccountScope } from '~/server/services/user.service';

const setUserName = async (id: number, setTo: string) => {
  try {
    setTo = setTo.replace(/[^A-Za-z0-9_]/g, '');
    const { username } = await dbWrite.user.update({
      where: { id },
      data: {
        username: `${setTo.split('@')[0]}${getRandomInt(100, 999)}`,
      },
      select: {
        username: true,
      },
    });
    return username ? username : undefined;
  } catch (e) {
    return undefined;
  }
};

const useSecureCookies = env.NEXTAUTH_URL.startsWith('https://');
const cookiePrefix = useSecureCookies ? '__Secure-' : '';
const { hostname } = new URL(env.NEXTAUTH_URL);
const cookieName = `${cookiePrefix}civitai-token`;

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(dbWrite),
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  events: {
    createUser: async ({ user }) => {
      const startingUsername = user.email?.trim() ?? user.name?.trim() ?? `civ_`;
      if (startingUsername) {
        let username: string | undefined = undefined;
        while (!username) username = await setUserName(Number(user.id), startingUsername);
      }
    },
  },
  callbacks: {
    async signIn({ account }) {
      if (account?.provider === 'discord' && !!account.scope) await updateAccountScope(account);

      return true;
    },
    async jwt({ token, user, trigger }) {
      if (trigger === 'update') {
        await invalidateSession(Number(token.sub));
        const user = await getSessionUser({ userId: Number(token.sub) });
        token.user = user;
      } else {
        token.sub = Number(token.sub) as any; //eslint-disable-line
        if (user) token.user = user;
        const { deletedAt, ...restUser } = token.user as User;
        token.user = { ...restUser };
      }

      return token;
    },
    async session({ session, token }) {
      token = await refreshToken(token);
      session.user = (token.user ? token.user : session.user) as Session['user'];
      return session;
    },
  },
  // Configure one or more authentication providers
  providers: [
    DiscordProvider({
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      authorization: {
        params: { scope: 'identify email role_connections.write' },
      },
    }),
    GithubProvider({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    GoogleProvider({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    RedditProvider({
      clientId: env.REDDIT_CLIENT_ID,
      clientSecret: env.REDDIT_CLIENT_SECRET,
      authorization: {
        params: {
          duration: 'permanent',
        },
      },
    }),
    EmailProvider({
      server: {
        host: env.EMAIL_HOST,
        port: env.EMAIL_PORT,
        auth: {
          user: env.EMAIL_USER,
          pass: env.EMAIL_PASS,
        },
      },
      sendVerificationRequest,
      from: env.EMAIL_FROM,
    }),
  ],
  cookies: {
    sessionToken: {
      name: cookieName,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: useSecureCookies,
        domain: hostname == 'localhost' ? hostname : '.' + hostname, // add a . in front so that subdomains are included
      },
    },
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
};

export default NextAuth(authOptions);
