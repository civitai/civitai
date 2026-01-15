import { PrismaAdapter } from '@next-auth/prisma-adapter';
import type { Prisma, PrismaClient, User } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import type { NextAuthOptions } from 'next-auth';
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
import { civitaiTokenCookieName, useSecureCookies } from '~/libs/auth';
import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { verificationEmail } from '~/server/email/templates';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';
import { encryptedDataSchema } from '~/server/schema/civToken.schema';
import { getBlockedEmailDomains } from '~/server/services/blocklist.service';
import { getSessionUser } from './session-user';
import { createLimiter } from '~/server/utils/rate-limiting';
import { getProtocol } from '~/server/utils/request-helpers';
import { trackToken } from '~/server/auth/token-tracking';
import { refreshToken } from '~/server/auth/token-refresh';
import { refreshSession } from '~/server/auth/session-invalidation';
import { getRequestDomainColor } from '~/shared/constants/domain.constants';
import { getRandomInt } from '~/utils/number-helpers';
import { generateToken } from '~/utils/string-helpers';
import { civTokenDecrypt } from './civ-token';
import { isDefined } from '~/utils/type-guards';
import { userUpdateCounter } from '~/server/prom/client';

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
    userUpdateCounter?.inc({ location: 'nextauth:setUserName' });
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
        const potentialUsernames = [user.email?.trim(), user.name?.trim(), generateToken(5) + '_']
          .filter(isDefined)
          .map((x) => x.split('@')[0].replace(/[^A-Za-z0-9_]/g, ''));

        for (const startingUsername of potentialUsernames) {
          let attempts = 2;
          let username: string | undefined = undefined;
          while (!username && attempts > 0) {
            username = await setUserName(Number(user.id), startingUsername);
            attempts--;
          }
          if (username) break;
        }
      },
    },
    callbacks: {
      async signIn({ account, email, user }) {
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
        // Handle manual session update (e.g., when user clicks "refresh session")
        if (trigger === 'update') {
          // Clear cache first, then fetch fresh user data to avoid getting stale cached data
          // Also mark all user's tokens for refresh in case they have multiple sessions
          await refreshSession(Number(token.sub));
          // Now fetch fresh user data (cache is cleared, so this will hit the database)
          const freshUser = await getSessionUser({ userId: Number(token.sub) });
          if (freshUser) {
            token.user = freshUser;
            token.signedAt = Date.now(); // Update signedAt to mark this refresh
          }

          // Return immediately - no need to go through refreshToken() since we just refreshed
          return token;
        }

        // Handle initial token setup (not update trigger)
        token.sub = Number(token.sub) as any; //eslint-disable-line

        const isNewToken = !token.id;
        if (isNewToken) {
          token.id = uuid();
          token.signedAt = Date.now();
        }

        if (isNewToken) {
          token.user = await getSessionUser({ userId: Number(user.id) });
        }

        // Track new tokens
        if (isNewToken && token.user) {
          await trackToken(token.id as string, (token.user as User).id);
        }

        const { deletedAt, ...restUser } = (token.user ?? {}) as User;
        token.user = { ...restUser };

        // Note: We don't call refreshToken here anymore.
        // The session callback handles all refresh/invalidation logic.
        // This keeps the JWT callback simple and avoids double-processing
        // which would consume the Redis state before the session callback sees it.

        return token;
      },
      async session({ session, token }) {
        if (!token.user || !token.id) {
          return session;
        }

        // Validate and refresh token on every request (this runs on every getServerSession call)
        // This ensures invalidated sessions are caught immediately
        const refreshResult = await refreshToken(token);

        if (!refreshResult.token) {
          // Token was invalidated or expired - return empty session to force logout
          if (refreshResult.needsCookieRefresh) {
            return { needsCookieRefresh: true };
          }
          return {} as any;
        }

        // Token is valid, use the (potentially refreshed) user data
        session.user = refreshResult.token.user as any;

        // Signal that client's session cookie needs refreshing
        if (refreshResult.needsCookieRefresh) {
          session.needsCookieRefresh = true;
        }

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
        profile(profile) {
          return {
            id: profile.id,
            name: profile.username,
            email: profile.email,
            image: null, // Don't store Discord avatar
          } as any;
        },
      }),
      GithubProvider({
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        allowDangerousEmailAccountLinking: true,
        profile(profile) {
          return {
            id: String(profile.id),
            name: profile.name ?? profile.login,
            email: profile.email,
            image: null, // Don't store GitHub avatar
          } as any;
        },
      }),
      GoogleProvider({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        allowDangerousEmailAccountLinking: true,
        profile(profile) {
          return {
            id: profile.sub,
            name: profile.name,
            email: profile.email,
            image: null, // Don't store Google avatar
          } as any;
        },
      }),
      RedditProvider({
        clientId: env.REDDIT_CLIENT_ID,
        clientSecret: env.REDDIT_CLIENT_SECRET,
        authorization: {
          params: {
            duration: 'permanent',
          },
        },
        profile(profile) {
          return {
            id: profile.id,
            name: profile.name,
            email: null, // Reddit doesn't provide email
            image: null, // Don't store Reddit avatar
          } as any;
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
  req.headers.origin = `${protocol}://${req.headers.host as string}`;
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

const updateAccountScope = async ({
  providerAccountId,
  provider,
  scope,
}: {
  providerAccountId: string;
  provider: string;
  scope?: string;
}) => {
  if (!scope) return;

  const account = await dbWrite.account.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId } },
    select: { id: true, scope: true },
  });
  if (account && !!account.scope) {
    const currentScope = account.scope.split(' ');
    const hasNewScope = scope?.split(' ').some((s) => !currentScope.includes(s));
    if (hasNewScope) await dbWrite.account.update({ where: { id: account.id }, data: { scope } });
  }
};
