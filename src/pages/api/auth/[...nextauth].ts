import NextAuth, { type NextAuthOptions } from 'next-auth';
import DiscordProvider from 'next-auth/providers/discord';
import GithubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';

// Prisma adapter for NextAuth, optional and can be removed
import { PrismaAdapter } from '@next-auth/prisma-adapter';
import { env } from '~/env/server.mjs';
import { prisma } from '~/server/db/client';
import { GetServerSidePropsContext, PreviewData } from 'next';
import { ParsedUrlQuery } from 'querystring';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  // Include user.id on session
  callbacks: {
    session({ session, user }) {
      const localSession = { ...session };

      if (localSession.user) {
        localSession.user.id = Number(user.id);
      }

      return localSession;
    },
    redirect({ url, baseUrl }) {
      // Allows relative callback URLs
      if (url.startsWith('/')) return `${baseUrl}${url}`;
      // Allows callback URLs on the same origin
      else if (new URL(url).origin === baseUrl) return url;
      return baseUrl;
    },
  },
  // Configure one or more authentication providers
  providers: [
    GithubProvider({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    }),
    DiscordProvider({
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
    }),
    GoogleProvider({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  pages: {
    signIn: '/login',
    error: '/login',
  },
};

export const getSessionUser = async (ctx: GetServerSidePropsContext<ParsedUrlQuery, PreviewData>) =>
  getServerAuthSession(ctx);

export default NextAuth(authOptions);
