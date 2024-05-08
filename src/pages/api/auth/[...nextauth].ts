import { PrismaAdapter } from '@next-auth/prisma-adapter';
import { Prisma, PrismaClient, User } from '@prisma/client';
import dayjs from 'dayjs';
import { NextApiRequest, NextApiResponse } from 'next';
import NextAuth, { type NextAuthOptions, Session } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import DiscordProvider from 'next-auth/providers/discord';
import EmailProvider, { SendVerificationRequestParams } from 'next-auth/providers/email';
import GithubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';
import RedditProvider from 'next-auth/providers/reddit';
import { v4 as uuid } from 'uuid';
import { isDev } from '~/env/other';

import { env } from '~/env/server.mjs';
import { callbackCookieName, civitaiTokenCookieName, useSecureCookies } from '~/libs/auth';
import { civTokenDecrypt } from '~/pages/api/auth/civ-token';
import { Tracker } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { verificationEmail } from '~/server/email/templates';
import { loginCounter, newUserCounter } from '~/server/prom/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { encryptedDataSchema } from '~/server/schema/civToken.schema';
import {
  createUserReferral,
  getSessionUser,
  updateAccountScope,
} from '~/server/services/user.service';
import blockedDomains from '~/server/utils/email-domain-blocklist.json';
import { createLimiter } from '~/server/utils/rate-limiting';
import { invalidateSession, invalidateToken, refreshToken } from '~/server/utils/session-helpers';
import { getRandomInt } from '~/utils/number-helpers';

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

function CustomPrismaAdapter(prismaClient: PrismaClient) {
  const adapter = PrismaAdapter(prismaClient);
  adapter.useVerificationToken = async (identifier_token) => {
    try {
      // We are going to stop deleting this token to handle email services that scan for malicious links
      // const verificationToken = await prismaClient.verificationToken.delete({
      //   where: { identifier_token },
      // });
      return await prismaClient.verificationToken.findUniqueOrThrow({
        where: { identifier_token },
      });
    } catch (error) {
      // If token already used/deleted, just return null
      // https://www.prisma.io/docs/reference/api-reference/error-reference#p2025
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2025') return null;
      throw error;
    }
  };

  return adapter;
}

export function createAuthOptions(): NextAuthOptions {
  return {
    adapter: CustomPrismaAdapter(dbWrite),
    session: {
      strategy: 'jwt',
      maxAge: 30 * 24 * 60 * 60, // 30 days
    },
    events: {
      createUser: async ({ user }) => {
        if (user.username) return; // Somehow this was being run for existing users, so we need to check for username...
        const startingUsername = user.email?.trim() ?? user.name?.trim() ?? `civ_`;

        if (startingUsername) {
          let username: string | undefined = undefined;
          while (!username) username = await setUserName(Number(user.id), startingUsername);
        }
      },
      signOut: async ({ token }) => {
        await invalidateToken(token);
      },
    },
    callbacks: {
      async signIn({ account }) {
        // console.log('signIn', account?.userId);
        if (account?.provider === 'discord' && !!account.scope) await updateAccountScope(account);

        return true;
      },
      async jwt({ token, user, trigger }) {
        // console.log('jwt', token.email);
        if (trigger === 'update') {
          await invalidateSession(Number(token.sub));
          token.user = await getSessionUser({ userId: Number(token.sub) });
        } else {
          token.sub = Number(token.sub) as any; //eslint-disable-line
          if (user) token.user = user;
          const { deletedAt, ...restUser } = token.user as User;
          token.user = { ...restUser };
        }
        if (!token.id) token.id = uuid();

        return token;
      },
      async session({ session, token }) {
        // console.log('session', session.user?.email);
        const newToken = await refreshToken(token);
        if (!newToken?.user) return {} as Session;
        session.user = (newToken.user ? newToken.user : session.user) as Session['user'];
        return session;
      },
      async redirect({ url, baseUrl }) {
        // console.log('redirect');
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
      // TODO do we need to remove this from getproviders() list?
      CredentialsProvider({
        id: 'account-switch',
        name: 'Account Switch',
        credentials: {
          iv: {
            label: 'iv',
            type: 'text',
            value: '',
          },
          data: {
            label: 'data',
            type: 'text',
            value: '',
          },
          signedAt: {
            label: 'signedAt',
            type: 'text',
            value: '',
          },
        },
        async authorize(credentials) {
          if (!credentials) throw new Error('No credentials provided.');

          try {
            const inputData = encryptedDataSchema.parse(credentials);
            const userId = Number(civTokenDecrypt(inputData));
            const user = await getSessionUser({ userId });
            if (!user) throw new Error('No user found.');
            return user;
          } catch (e: unknown) {
            // TODO are these not being shown? do we need an error page?
            const err = e as Error;
            throw new Error(`Failed to authenticate credentials: ${err.message}.`);
          }
        },
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
  // Yes, this is intended. Without this, you can't log in to a user
  // while already logged in as another
  if (req.url?.startsWith('/api/auth/callback/')) {
    const callbackUrl = req.cookies[callbackCookieName];
    if (!callbackUrl?.includes('connect=true')) delete req.cookies[civitaiTokenCookieName];
  }

  customAuthOptions.events ??= {};
  // customAuthOptions.events.session = async (message) => {
  //   console.log('session event', message.session?.user?.email, message.token?.email);
  // };
  customAuthOptions.events.signIn = async (context) => {
    // console.log('signin event', context.user?.email, context.account?.userId);

    const source = req.cookies['ref_source'] as string;
    const landingPage = req.cookies['ref_landing_page'] as string;
    const loginRedirectReason = req.cookies['ref_login_redirect_reason'] as string;

    if (context.isNewUser) {
      newUserCounter.inc();
      const tracker = new Tracker(req, res);
      await tracker.userActivity({
        type: 'Registration',
        targetUserId: context.user.id,
        source,
        landingPage,
      });

      if (source || landingPage || loginRedirectReason) {
        // Only source will be set via the auth callback.
        // For userReferralCode, the user must finish onboarding.
        await createUserReferral({
          id: context.user.id,
          source,
          landingPage,
          loginRedirectReason,
        });
      }
    } else {
      loginCounter.inc();
    }
  };

  return await NextAuth(req, res, customAuthOptions);
}

const emailLimiter = createLimiter({
  counterKey: REDIS_KEYS.COUNTERS.EMAIL_VERIFICATIONS,
  limitKey: REDIS_KEYS.LIMITS.EMAIL_VERIFICATIONS,
  fetchCount: async () => 0,
  refetchInterval: CacheTTL.day,
});

async function sendVerificationRequest({
  identifier: to,
  url,
  theme,
}: SendVerificationRequestParams) {
  const emailDomain = to.split('@')[1];
  if (blockedDomains.includes(emailDomain)) {
    throw new Error(`Email domain ${emailDomain} is not allowed`);
  }

  if (await emailLimiter.hasExceededLimit(to)) {
    const limitHitTime = await emailLimiter.getLimitHitTime(to);
    let message = 'Too many verification emails sent to this address';
    if (limitHitTime)
      message += ` - Please try again ${dayjs(limitHitTime).add(1, 'day').fromNow()}.`;
    throw new Error(message);
  }

  await verificationEmail.send({ to, url, theme });
  await emailLimiter.increment(to);
}
