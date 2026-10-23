import {
  AbstractGrantType,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  OAuthError,
  UnauthorizedClientError,
  type Client,
  type Request,
  type Token,
} from '@node-oauth/oauth2-server';
import { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import {
  DEVICE_ID_TOKEN_TYPE,
  JWT_TOKEN_TYPE,
  OAUTH_TOKEN_PREFIX,
  WORKER_TOKEN_TTL,
} from './constants';
import { checkOAuthRateLimit } from './rate-limit';
import { logOAuthEvent } from './audit-log';
import { scopeToString, stringToScope } from './scope';
import { SaladTokenError, saladJwtEnabled, verifySaladJwt } from './worker-salad';

// RFC 8693 token exchange for workload clients: the client authenticates with its secret (the library
// does that before `handle`), the worker presents its device credential as `subject_token`, and gets back
// a `Worker` token carrying only WorkerRegister, with no refresh token.

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** What the token route attaches to the library request for this grant. */
export type WorkerGrantRequestContext = { clientIp: string | null };

type WorkerDeviceRef = { issuer: 'self' | 'salad'; subject: string };

class RateLimitedError extends OAuthError {
  constructor() {
    super('Too many token requests for this device', { code: 429, name: 'rate_limited' });
  }
}

export class WorkerTokenExchangeGrant extends AbstractGrantType {
  async handle(request: Request, client: Client): Promise<Token> {
    const body = request.body as Record<string, unknown>;
    const ctx = (request as Request & { workerGrant?: WorkerGrantRequestContext }).workerGrant;
    const clientIp = ctx?.clientIp ?? null;

    const subjectToken = typeof body.subject_token === 'string' ? body.subject_token : '';
    const subjectTokenType =
      typeof body.subject_token_type === 'string' ? body.subject_token_type : '';
    if (!subjectToken || !subjectTokenType) {
      throw new InvalidRequestError('Missing parameter: `subject_token` or `subject_token_type`');
    }
    if (
      body.scope !== undefined &&
      stringToScope(String(body.scope)) !== TokenScope.WorkerRegister
    ) {
      throw new InvalidScopeError('Invalid scope: only WorkerRegister can be requested');
    }

    const workload = await db
      .selectFrom('WorkerClient')
      .innerJoin('OauthClient', 'OauthClient.id', 'WorkerClient.clientId')
      .select([
        'WorkerClient.clientId',
        'WorkerClient.saladContainerGroupIds',
        'OauthClient.userId',
        'OauthClient.allowedScopes',
        'OauthClient.isConfidential',
      ])
      .where('WorkerClient.clientId', '=', client.id)
      .executeTakeFirst();
    if (!workload?.isConfidential || (workload.allowedScopes & TokenScope.WorkerRegister) === 0) {
      throw new UnauthorizedClientError('Unauthorized client: not a workload client');
    }

    const device = await resolveDevice(subjectToken, subjectTokenType, workload);

    if (
      !(await checkOAuthRateLimit(
        'worker-device',
        `${workload.clientId}:${device.issuer}:${device.subject}`
      ))
    ) {
      throw new RateLimitedError();
    }

    const now = new Date();
    const deviceRow = await db
      .insertInto('WorkerDevice')
      .values({
        clientId: workload.clientId,
        issuer: device.issuer,
        subject: device.subject,
        lastIp: clientIp,
      })
      .onConflict((oc) =>
        oc
          .columns(['clientId', 'issuer', 'subject'])
          .doUpdateSet({ lastSeenAt: now, lastIp: clientIp })
      )
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();
    if (deviceRow.status !== 'active') {
      throw new InvalidGrantError('Invalid grant: device is blocked');
    }

    // Each exchange adds a row, so clear this device's expired ones as it goes.
    await db
      .deleteFrom('ApiKey')
      .where('workerDeviceId', '=', deviceRow.id)
      .where('type', '=', 'Worker')
      .where('expiresAt', '<', now)
      .execute();

    const accessToken = OAUTH_TOKEN_PREFIX + generateKey(36);
    const expiresAt = new Date(now.getTime() + WORKER_TOKEN_TTL * 1000);
    await db
      .insertInto('ApiKey')
      .values({
        key: generateSecretHash(accessToken),
        name: `worker:${workload.clientId}`,
        tokenScope: TokenScope.WorkerRegister,
        userId: workload.userId,
        type: 'Worker',
        expiresAt,
        clientId: workload.clientId,
        workerDeviceId: deviceRow.id,
      })
      .execute();

    logOAuthEvent({
      type: 'worker.token.issued',
      userId: workload.userId,
      clientId: workload.clientId,
      scope: TokenScope.WorkerRegister,
      ip: clientIp ?? 'unknown',
      metadata: { workerDeviceId: deviceRow.id, issuer: device.issuer, deviceId: device.subject },
    });

    return {
      accessToken,
      accessTokenExpiresAt: expiresAt,
      scope: scopeToString(TokenScope.WorkerRegister),
      client,
      user: { id: workload.userId },
    } as Token;
  }
}

async function resolveDevice(
  subjectToken: string,
  subjectTokenType: string,
  workload: { saladContainerGroupIds: string[] }
): Promise<WorkerDeviceRef> {
  if (subjectTokenType === DEVICE_ID_TOKEN_TYPE) {
    if (!DEVICE_ID_PATTERN.test(subjectToken)) {
      throw new InvalidRequestError('Invalid parameter: `subject_token`');
    }
    return { issuer: 'self', subject: subjectToken };
  }

  if (subjectTokenType === JWT_TOKEN_TYPE && saladJwtEnabled()) {
    try {
      const salad = await verifySaladJwt(subjectToken);
      if (!workload.saladContainerGroupIds.includes(salad.containerGroupId)) {
        throw new InvalidGrantError(
          'Invalid grant: container group is not allowed for this client'
        );
      }
      return { issuer: 'salad', subject: salad.machineId };
    } catch (err) {
      if (err instanceof SaladTokenError)
        throw new InvalidGrantError(`Invalid grant: ${err.message}`);
      throw err;
    }
  }

  throw new InvalidRequestError('Unsupported `subject_token_type`');
}
