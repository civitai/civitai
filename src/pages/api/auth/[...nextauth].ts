import { PrismaAdapter } from '@next-auth/prisma-adapter';
import type { Prisma, PrismaClient, User } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from 'next-auth';
import NextAuth, { type NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import DiscordProvider from 'next-auth/providers/discord';
import type { SendVerificationRequestParams } from 'next-auth/providers/email';
import EmailProvider from 'next-auth/providers/email';
import GithubProvider from 'next-auth/providers/github';
import GoogleProvider from 'next-auth/providers/google';
import RedditProvider from 'next-auth/providers/reddit';
import { v4 as uuid } from 'uuid';
import { isDev, isTest } from '~/env/other';
import { env } from '~/env/server';
import { callbackCookieName, civitaiTokenCookieName, useSecureCookies } from '~/libs/auth';
import { civTokenDecrypt } from '~/pages/api/auth/civ-token'; // TODO move this to server
import { Tracker } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { verificationEmail } from '~/server/email/templates';
import { logToAxiom } from '~/server/logging/client';
import { loginCounter, newUserCounter } from '~/server/prom/client';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';
import { encryptedDataSchema } from '~/server/schema/civToken.schema';
import { getBlockedEmailDomains } from '~/server/services/blocklist.service';
import { createNotification } from '~/server/services/notification.service';
import {
  createUserReferral,
  getSessionUser,
  updateAccountScope,
} from '~/server/services/user.service';
import { deleteEncryptedCookie } from '~/server/utils/cookie-encryption';
import { createLimiter } from '~/server/utils/rate-limiting';
import { getProtocol } from '~/server/utils/request-helpers';
import { invalidateSession, invalidateToken, refreshToken } from '~/server/utils/session-helpers';
import { getRequestDomainColor } from '~/shared/constants/domain.constants';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
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

type AuthedRequest = {
  url?: string;
  headers: {
    host?: string;
    origin?: string;
    'x-forwarded-proto'?: string;
  };
};

export function createAuthOptions(req?: AuthedRequest): NextAuthOptions {
  const options: NextAuthOptions = {
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
      async signIn({ account, email, user }) {
        // console.log(new Date().toISOString() + ' ::', 'signIn', { account, email, user });
        if (account?.provider === 'discord' && !!account.scope) await updateAccountScope(account);
        if (
          account?.provider === 'email' &&
          !user.emailVerified &&
          email?.verificationRequest &&
          user.email?.includes('+') &&
          !isDev
        ) {
          const alreadyExists = await dbWrite.user.findFirst({
            where: { email: user.email },
            select: { id: true },
          });

          // Needs to return false to prevent login,
          // otherwise next-auth fails because of a bug
          // if we return a string and it's set to redirect: false
          if (alreadyExists) return true;
          else return false;
        }

        if (email?.verificationRequest && account && account.provider === 'email') {
          const canSignIn = await isAllowedToSignIn({ email: account.providerAccountId });
          return canSignIn;
        }

        return true;
      },
      async jwt({ token, user, trigger }) {
        // console.log(new Date().toISOString() + ' ::', 'jwt', token.email, token.id, trigger);
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
        // console.log(new Date().toISOString() + ' ::', 'session', session.user?.email);
        const newToken = await refreshToken(token);
        // console.log(new Date().toISOString() + ' ::', newToken?.name);
        if (!newToken?.user) return {} as Session;
        session.user = (newToken.user ? newToken.user : session.user) as Session['user'];
        return session;
      },
      async redirect({ url, baseUrl }) {
        // console.log('redirect', url, baseUrl);
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
      ...(isDev || isTest
        ? [
            CredentialsProvider({
              id: 'testing-login',
              name: 'Testing Login',
              credentials: {
                id: { label: 'id', type: 'text' },
              },
              async authorize(credentials) {
                if (!(isDev || isTest)) return null;

                const { id } = credentials ?? {};
                if (!id) throw new Error('No id provided.');

                try {
                  const userId = Number(id);
                  const user = await getSessionUser({ userId });
                  if (!user) throw new Error('No user found.');
                  return user;
                } catch (e: unknown) {
                  const err = e as Error;
                  throw new Error(`Failed to authenticate: ${err.message}.`);
                }
              },
            }),
          ]
        : []),
      CredentialsProvider({
        id: 'token-login',
        name: 'Token Login',
        credentials: {
          token: { label: 'token', type: 'text' },
        },
        async authorize(credentials) {
          const { token } = credentials ?? {};
          if (!token) throw new Error('No token provided.');

          const tokenMap = env.TOKEN_LOGINS?.[token];
          if (!tokenMap) throw new Error('Invalid token.');

          try {
            const userId = Number(tokenMap);
            const user = await getSessionUser({ userId });
            if (!user) throw new Error('No user found.');
            return user;
          } catch (e: unknown) {
            const err = e as Error;
            throw new Error(`Failed to authenticate: ${err.message}.`);
          }
        },
      }),
    ],
    cookies: {
      sessionToken: {
        name: civitaiTokenCookieName,
        options: {
          httpOnly: true,
          sameSite: hostname == 'localhost' ? 'lax' : 'none',
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

  if (!req) return options;

  // Request specific customizations
  // -------------------------------

  // Handle request hostname
  const protocol = getProtocol(req);
  req.headers.origin = `${protocol}://${req.headers.host}`;
  const { hostname: reqHostname } = new URL(req.headers.origin);

  // Handle domain-specific cookie
  const domainColor = getRequestDomainColor(req);
  if (domainColor && !!options.cookies?.sessionToken?.options?.domain) {
    options.cookies.sessionToken.options.domain =
      (reqHostname !== 'localhost' ? '.' : '') + reqHostname;
  }

  // Handle domain-specific auth settings
  if (
    domainColor &&
    (req.url?.startsWith('/api/auth/signin') ||
      req.url?.startsWith('/api/auth/signout') ||
      req.url?.startsWith('/api/auth/callback'))
  ) {
    // Update the provider options
    for (const provider of options.providers) {
      // Set the correct redirect uri
      provider.options.authorization ??= {};
      provider.options.authorization.params ??= {};
      provider.options.authorization.params.redirect_uri = `${req.headers.origin}/api/auth/callback/${provider.id}`;

      // Set the correct client id and secret when needed
      const clientId = process.env[`${provider.id}_CLIENT_ID_${domainColor}`.toUpperCase()];
      const clientSecret = process.env[`${provider.id}_CLIENT_SECRET_${domainColor}`.toUpperCase()];
      if (clientId && clientSecret) {
        provider.options.clientId = clientId;
        provider.options.clientSecret = clientSecret;
      }
    }
  }

  return options;
}

export default async function auth(req: NextApiRequest, res: NextApiResponse) {
  // console.log(new Date().toISOString() + ' ::', 'nextauth', req.url);
  const customAuthOptions = createAuthOptions(req);
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

  customAuthOptions.events.signOut = async (context) => {
    // console.log('signout event', context.user?.email, context.account?.userId);
    deleteEncryptedCookie({ req, res }, { name: generationServiceCookie.name });
  };

  customAuthOptions.events.signIn = async (context) => {
    // console.log('signin event', context.user?.email, context.account?.userId);
    deleteEncryptedCookie({ req, res }, { name: generationServiceCookie.name });

    const source = req.cookies['ref_source'] as string;
    const landingPage = req.cookies['ref_landing_page'] as string;
    const loginRedirectReason = req.cookies['ref_login_redirect_reason'] as string;

    const tracker = new Tracker(req, res);
    if (context.isNewUser) {
      newUserCounter?.inc();
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

      // does this work for email login? it should
      await createNotification({
        type: 'join-community',
        userId: context.user.id,
        category: NotificationCategory.System,
        key: `join-community:${context.user.id}`,
        details: {},
      }).catch();
    } else {
      loginCounter?.inc();
      await tracker.userActivity({
        type: 'Login',
        targetUserId: context.user.id,
        source,
        landingPage,
      });
    }
  };

  return await NextAuth(req, res, customAuthOptions);
}

const emailLimiter = createLimiter({
  counterKey: REDIS_KEYS.COUNTERS.EMAIL_VERIFICATIONS,
  limitKey: REDIS_SYS_KEYS.LIMITS.EMAIL_VERIFICATIONS,
  fetchCount: async () => 0,
  refetchInterval: CacheTTL.day,
});

async function sendVerificationRequest({
  identifier: to,
  url,
  theme,
}: SendVerificationRequestParams) {
  try {
    await verificationEmail.send({ to, url, theme });
    await emailLimiter.increment(to).catch(() => null);
  } catch (error) {
    logToAxiom({
      name: 'verification-email',
      type: 'error',
      message: 'Failed to send verification email',
      error,
    });
    throw new Error('Failed to send verification email');
  }
}

async function isAllowedToSignIn({ email }: { email: string }) {
  try {
    const emailDomain = email.split('@')[1];
    const blockedDomains = await getBlockedEmailDomains();
    if (blockedDomains.includes(emailDomain)) {
      throw new Error(`Email domain ${emailDomain} is not allowed`);
    }

    if (await emailLimiter.hasExceededLimit(email)) {
      const limitHitTime = await emailLimiter.getLimitHitTime(email);
      let message = 'Too many verification emails sent to this address';
      if (limitHitTime)
        message += ` - Please try again ${dayjs(limitHitTime).add(1, 'day').fromNow()}.`;
      throw new Error(message);
    }
  } catch (error) {
    throw error;
  }

  return true;
}
