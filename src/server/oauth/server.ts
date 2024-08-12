import OAuth2Server, {
  AuthorizationCodeModel,
  RefreshToken,
  RefreshTokenModel,
  Token,
} from '@node-oauth/oauth2-server';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { dbRead, dbWrite } from '../db/client';
import { generateSecretHash } from '~/server/utils/key-generator';
import { ApiKeyType, KeyScope } from '@prisma/client';
import { generateToken } from '~/utils/string-helpers';
import { env } from '~/env/server.mjs';

type AuthorizationCodeRecord = {
  expiresAt: Date;
  redirectUri: string;
  scope?: string[];
  clientId: string;
  userId: number;
};

function secureToken(token: string) {
  return generateSecretHash(token);
}

const grants = ['authorization_code', 'refresh_token'];
const model: AuthorizationCodeModel | RefreshTokenModel = {
  // Client
  // ----------------------------------------------
  async getClient(clientId: string, clientSecret: string) {
    const client = await dbRead.oauthClient.findUnique({
      where: { id: clientId },
    });
    if (!client) return false;

    return {
      id: client.id,
      name: client.name,
      redirectUris: client.redirectUris,
      grants,
    };
  },

  // Authorization Code
  // ----------------------------------------------
  // async generateAuthorizationCode(client, user, scope) {
  //   // If not implemented, a default handler is used that generates authorization codes consisting of 40 characters in the range of a..z0..9.
  // },
  async saveAuthorizationCode(code, client, user) {
    await Promise.all([
      redis.packed.hSet<AuthorizationCodeRecord>(
        REDIS_KEYS.SYSTEM.OAUTH.AUTHORIZATION_CODES,
        secureToken(code.authorizationCode),
        {
          redirectUri: code.redirectUri,
          scope: code.scope,
          clientId: client.id,
          userId: user.id,
          expiresAt: code.expiresAt,
        }
      ),
      redis.hExpireAt(
        REDIS_KEYS.SYSTEM.OAUTH.AUTHORIZATION_CODES,
        code.authorizationCode,
        code.expiresAt
      ),
    ]);
    return {
      authorizationCode: code.authorizationCode,
      expiresAt: code.expiresAt,
      redirectUri: code.redirectUri,
      scope: code.scope,
      client,
      user,
    };
  },
  async getAuthorizationCode(authorizationCode) {
    const authorizationCodeRecord = await redis.packed.hGet<AuthorizationCodeRecord>(
      REDIS_KEYS.SYSTEM.OAUTH.AUTHORIZATION_CODES,
      secureToken(authorizationCode)
    );
    if (!authorizationCodeRecord) return false;
    return {
      authorizationCode,
      expiresAt: authorizationCodeRecord.expiresAt,
      redirectUri: authorizationCodeRecord.redirectUri,
      scope: authorizationCodeRecord.scope,
      client: { id: authorizationCodeRecord.clientId, grants },
      user: { id: authorizationCodeRecord.userId },
    };
  },
  async revokeAuthorizationCode(code) {
    await redis.hDel(
      REDIS_KEYS.SYSTEM.OAUTH.AUTHORIZATION_CODES,
      secureToken(code.authorizationCode)
    );
    return true;
  },
  // async validateScope(user, client, scope) {
  //   // If not implemented, any scope is accepted.
  // },
  // async validateRedirectUri(redirect_uri, client) {
  //   // If not implemented, any redirect URI in client is accepted.
  // },

  // Refresh Token
  // ----------------------------------------------
  // async generateRefreshToken(client, user, scope) {
  //   // If not implemented, a default handler is used that generates refresh tokens consisting of 40 characters in the range of a..z0..9.
  // },
  async getRefreshToken(refreshToken) {
    const token = await dbRead.apiKey.findUnique({
      where: {
        key: secureToken(refreshToken),
        type: ApiKeyType.Refresh,
      },
    });
    if (!token) return false;

    return {
      refreshToken,
      refreshTokenExpiresAt: token.expiresAt,
      scope: token.scope,
      client: { id: token.clientId, grants },
      user: { id: token.userId },
    } as RefreshToken;
  },

  // Access Token
  // ----------------------------------------------
  async generateAccessToken(client, user, scope) {
    // If not implemented, a default handler is used that generates access tokens consisting of 40 characters in the range of a..z0..9.
    return `${env.OAUTH_TOKEN_PREFIX}${generateToken(36)}`;
  },
  async getAccessToken(accessToken: string) {
    const token = await dbRead.apiKey.findUnique({
      where: {
        key: secureToken(accessToken),
        type: ApiKeyType.Access,
      },
    });
    if (!token) return false;

    return {
      accessToken,
      accessTokenExpiresAt: token.expiresAt,
      scope: token.scope,
      client: { id: token.clientId, grants },
      user: { id: token.userId },
    } as Token;
  },

  // Tokens
  // ----------------------------------------------
  async saveToken(token, client, user) {
    const baseToken = {
      name: `${client.name} token`,
      scope: token.scope?.map((x) => x as KeyScope),
      clientId: client.id,
      userId: user.id,
    };
    const tokens = [
      {
        ...baseToken,
        key: secureToken(token.accessToken),
        type: ApiKeyType.Access as ApiKeyType,
        expiresAt: token.accessTokenExpiresAt,
      },
    ];
    if (token.refreshToken) {
      tokens.push({
        ...baseToken,
        key: secureToken(token.refreshToken),
        type: ApiKeyType.Refresh,
        expiresAt: token.refreshTokenExpiresAt,
      });
    }

    await dbWrite.apiKey.createMany({
      data: tokens,
    });

    return {
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      refreshToken: token.refreshToken,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt,
      scope: token.scope,
      client,
      user,
    };
  },
  async revokeToken(token) {
    await dbWrite.apiKey.delete({
      where: {
        key: secureToken(token.refreshToken),
      },
    });
    return true;
  },
};

export const oauth = new OAuth2Server({
  model,
  accessTokenLifetime: 60 * 60 * 24 * 7, // 1 week
  refreshTokenLifetime: 60 * 60 * 24 * 30, // 30 days
  allowEmptyState: true,
  allowExtendedTokenAttributes: true,
});
