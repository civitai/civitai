import { PrismaAdapter } from '@next-auth/prisma-adapter';
import { User } from '@prisma/client';
import NextAuth, { Session, type NextAuthOptions } from 'next-auth';
import DiscordProvider from 'next-auth/providers/discord';
import GithubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';
import RedditProvider from 'next-auth/providers/reddit';
import EmailProvider, { SendVerificationRequestParams } from 'next-auth/providers/email';

import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { getRandomInt } from '~/utils/number-helpers';
import { refreshToken, invalidateSession } from '~/server/utils/session-helpers';
import {
  createUserReferral,
  getSessionUser,
  updateAccountScope,
} from '~/server/services/user.service';
import { Tracker } from '~/server/clickhouse/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { civitaiTokenCookieName, useSecureCookies } from '~/libs/auth';
import { isDev } from '~/env/other';
import { verificationEmail } from '~/server/email/templates';
import blockedDomains from '~/server/utils/email-domain-blocklist.json';
import { getCookie } from 'cookies-next';

const setUserName = async (id: number, setTo: string) => {
  try {
    setTo = setTo.split('@')[0].replace(/[^A-Za-z0-9_]/g, '');
    const { username } = await dbWrite.user.update({
      where: { id },
      data: {
        username: `${setTo}${getRandomInt(100, 999)}`,
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

const { hostname } = new URL(env.NEXTAUTH_URL);

export function createAuthOptions(): NextAuthOptions {
  return {
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
      async redirect({ url, baseUrl }) {
        if (url.startsWith('/')) return `${baseUrl}${url}`;
        // allow redirects to other civitai domains
        if (isDev || new URL(url).origin.includes('civitai')) return url;
        return baseUrl;
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
        name: civitaiTokenCookieName,
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
}

export const authOptions = createAuthOptions();

export default async function auth(req: NextApiRequest, res: NextApiResponse) {
  const customAuthOptions = createAuthOptions();
  customAuthOptions.events ??= {};
  customAuthOptions.events.signIn = async (context) => {
    const code = req.cookies['ref_code'] as string;
    const source = req.cookies['ref_source'] as string;

    if (context.isNewUser) {
      const tracker = new Tracker(req, res);
      await tracker.userActivity({
        type: 'Registration',
        targetUserId: parseInt(context.user.id),
      });

      if (code || source) {
        await createUserReferral({
          id: parseInt(context.user.id),
          userReferralCode: code,
          source,
        });
      }
    }
  };
  return await NextAuth(req, res, customAuthOptions);
}

async function sendVerificationRequest({
  identifier: to,
  url,
  theme,
}: SendVerificationRequestParams) {
  const emailDomain = to.split('@')[1];
  if (blockedDomains.includes(emailDomain)) {
    throw new Error(`Email domain ${emailDomain} is not allowed`);
  }

  await verificationEmail.send({ to, url, theme });
}
