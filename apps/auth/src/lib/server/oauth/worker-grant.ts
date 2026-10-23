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
  DEVICE_ID_PATTERN,
  DEVICE_ID_TOKEN_TYPE,
  JWT_TOKEN_TYPE,
  OAUTH_TOKEN_PREFIX,
  WORKER_TOKEN_TTL,
} from './constants';
import { checkOAuthRateLimit } from './rate-limit';
import { logOAuthEvent } from './audit-log';
import { scopeToString, stringToScope } from './scope';
import { SaladTokenError, saladJwtEnabled, verifySaladJwt } from './worker-salad';

// RFC 8693 token exchange for workload clients: a worker trades its device credential (`subject_token`)
// for a `Worker` token carrying only WorkerRegister, with no refresh token.

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
        'WorkerClient.subjectTokenTypes',
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
    const accessToken = OAUTH_TOKEN_PREFIX + generateKey(36);
    const expiresAt = new Date(now.getTime() + WORKER_TOKEN_TTL * 1000);
    // One transaction: the upsert holds the device row's lock until the token is written, so a
    // concurrent blockWorkerDevice either runs first (and this sees `blocked`) or deletes the new token.
    const deviceRow = await db.transaction().execute(async (trx) => {
      const row = await trx
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

      // Each exchange adds a row, so clear this device's old ones as it goes: expired ones, and any
      // left behind for a blocked device.
      let sweep = trx
        .deleteFrom('ApiKey')
        .where('workerDeviceId', '=', row.id)
        .where('type', '=', 'Worker');
      if (row.status === 'active') sweep = sweep.where('expiresAt', '<', now);
      await sweep.execute();
      if (row.status !== 'active') return row;

      await trx
        .insertInto('ApiKey')
        .values({
          key: generateSecretHash(accessToken),
          name: `worker:${workload.clientId}`,
          tokenScope: TokenScope.WorkerRegister,
          userId: workload.userId,
          type: 'Worker',
          expiresAt,
          clientId: workload.clientId,
          workerDeviceId: row.id,
        })
        .execute();
      return row;
    });
    if (deviceRow.status !== 'active') {
      throw new InvalidGrantError('Invalid grant: device is blocked');
    }

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
  workload: { subjectTokenTypes: string[]; saladContainerGroupIds: string[] }
): Promise<WorkerDeviceRef> {
  const notAccepted = () =>
    new InvalidGrantError('Invalid grant: `subject_token_type` is not accepted for this client');
  if (!workload.subjectTokenTypes.includes(subjectTokenType)) throw notAccepted();

  if (subjectTokenType === DEVICE_ID_TOKEN_TYPE) {
    // A Salad pool's devices are identified by their Salad tokens.
    if (workload.saladContainerGroupIds.length > 0) throw notAccepted();
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
