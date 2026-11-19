import type { NextApiRequest, NextApiResponse } from 'next';
import type * as z from 'zod';
import { env } from '~/env/server';
import { isConfiguredSecret } from '~/server/utils/configured-secret';
import { PayloadTooLarge, readRawBody } from '~/server/utils/raw-body';
import {
  beginHibernation,
  beginInput,
  commitHibernation,
  commitInput,
  restoreSecretsInput,
  restoreSleepingAppSecrets,
  type BeginResult,
  type CommitResult,
  type HibernationDeps,
  type RestoreSecretsResult,
} from '~/server/services/app-hibernation/app-hibernation.service';
import { verifyHibernationRequest } from '~/server/services/app-hibernation/internal-auth';

/**
 * The three routes the sandbox service calls, each answering in this order:
 *   503 the shared secret is not configured
 *   405 not a POST
 *   413 the body is over {@link MAX_BODY_BYTES}
 *   401 the signature or the timestamp is refused (`internal-auth.ts`)
 *   400 the body does not parse
 *   then the route's own answers (403 `disabled` when the `app-hibernate` flag is off for the
 *   user, 503 `not_configured` without the archive store or the master key, ...)
 * `Cache-Control: no-store` on every answer. The HMAC covers the RAW bytes, so the pages turn
 * Next's body parser off.
 */

export const HIBERNATION_PATHS = {
  begin: '/api/internal/app-hibernation/begin',
  commit: '/api/internal/app-hibernation/commit',
  secrets: '/api/internal/app-hibernation/secrets',
} as const;

const MAX_BODY_BYTES = 256 * 1024;

export type HibernationRouteDeps = {
  hibernation: () => Promise<HibernationDeps>;
  nowSeconds: () => number;
  /** Reports an unexpected failure (answered 503). */
  report: (event: string, details: Record<string, unknown>) => void;
};

async function defaultRouteDeps(): Promise<HibernationRouteDeps> {
  const { defaultHibernationDeps } = await import(
    '~/server/services/app-hibernation/hibernation-deps'
  );
  return {
    hibernation: defaultHibernationDeps,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    report: (event, details) => {
      void import('~/server/logging/client')
        .then(({ logToAxiom }) => logToAxiom({ type: event, ...details }))
        .catch(() => undefined);
    },
  };
}

type Answer = { status: number; json: Record<string, unknown> };

const disabled: Answer = {
  status: 403,
  json: { error: 'App hibernation is not enabled', code: 'disabled' },
};
const notConfigured: Answer = {
  status: 503,
  json: { error: 'App hibernation is not configured', code: 'not_configured' },
};
const accountClosed: Answer = {
  status: 403,
  json: { error: 'The account is deleted or banned', code: 'account_closed' },
};
const limitAnswer = (r: { limit: unknown; oldest: unknown }): Answer => ({
  status: 409,
  json: {
    error: 'Sleeping app limit reached',
    code: 'SLEEPING_LIMIT',
    limit: r.limit,
    oldest: r.oldest,
  },
});

export function beginAnswer(r: BeginResult): Answer {
  switch (r.kind) {
    case 'disabled':
      return disabled;
    case 'not-configured':
      return notConfigured;
    case 'account-closed':
      return accountClosed;
    case 'limit':
      return limitAnswer(r);
    case 'attempt-conflict':
      return {
        status: 409,
        json: { error: 'Attempt id belongs to another app', code: 'attempt_conflict' },
      };
    case 'ok':
      return {
        status: 200,
        json: {
          expiresAt: r.expiresAt,
          maxBytes: r.maxBytes,
          archive: r.archive,
        },
      };
  }
}

export function commitAnswer(r: CommitResult): Answer {
  switch (r.kind) {
    case 'disabled':
      return disabled;
    case 'not-configured':
      return notConfigured;
    case 'unknown-attempt':
      return { status: 404, json: { error: 'Unknown attempt', code: 'unknown_attempt' } };
    case 'mismatch':
      return {
        status: 409,
        json: { error: 'Stored object does not match', code: 'mismatch', reason: r.reason },
      };
    case 'secrets-too-large':
      return {
        status: 413,
        json: {
          error: 'The secrets blob is too large',
          code: 'secrets_too_large',
          limit: r.limit,
        },
      };
    case 'secrets-store-failed':
      return {
        status: 503,
        json: { error: 'Could not store the secrets; nothing was recorded', code: 'unavailable' },
      };
    case 'lineage':
      return {
        status: 409,
        json: {
          error: 'The sandbox was not woken from the stored record',
          code: 'lineage',
        },
      };
    case 'account-closed':
      return accountClosed;
    case 'limit':
      return limitAnswer(r);
    case 'committed':
      return { status: 200, json: { committed: true, sha256: r.sha256 } };
  }
}

export function restoreSecretsAnswer(r: RestoreSecretsResult): Answer {
  switch (r.kind) {
    case 'disabled':
      return disabled;
    case 'not-configured':
      return notConfigured;
    case 'account-closed':
      return accountClosed;
    case 'ticket':
      return {
        status: 403,
        json: { error: 'No valid wake ticket for this restore', code: 'ticket' },
      };
    case 'not-found':
      return { status: 404, json: { error: 'No sleeping app under that key', code: 'not_found' } };
    case 'stale':
      return {
        status: 409,
        json: { error: 'The record changed since that seed', code: 'stale' },
      };
    case 'ok':
      return { status: 200, json: { blob: r.blob } };
  }
}

function createRoute<S extends z.ZodType>(
  path: string,
  schema: S,
  handle: (body: z.infer<S>, deps: HibernationDeps) => Promise<Answer>,
  getDeps: () => Promise<HibernationRouteDeps>
) {
  return async function route(req: NextApiRequest, res: NextApiResponse) {
    res.setHeader('Cache-Control', 'no-store');
    const secret = env.APP_HIBERNATION_HMAC_SECRET;
    if (!isConfiguredSecret(secret))
      return res.status(503).json({ error: 'Endpoint not configured', code: 'not_configured' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    let raw: Buffer;
    try {
      raw = await readRawBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof PayloadTooLarge)
        return res.status(413).json({ error: 'Payload too large', code: 'too_large' });
      throw err;
    }

    const deps = await getDeps();
    const previous = env.APP_HIBERNATION_HMAC_SECRET_PREVIOUS;
    const auth = verifyHibernationRequest({
      secrets: isConfiguredSecret(previous) ? [secret, previous] : [secret],
      method: req.method,
      path,
      headers: req.headers,
      body: raw,
      nowSeconds: deps.nowSeconds(),
    });
    if (!auth.ok) return res.status(auth.status).json({ error: 'Unauthorized', code: auth.code });

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Body is not JSON', code: 'bad_request' });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: 'Body does not match the contract', code: 'bad_request' });

    try {
      const answer = await handle(parsed.data, await deps.hibernation());
      return res.status(answer.status).json(answer.json);
    } catch (err) {
      deps.report('app-hibernation.route-failed', { path, error: (err as Error)?.message });
      return res.status(503).json({ error: 'Try again later', code: 'unavailable' });
    }
  };
}

export function createHibernationRoutes(
  getDeps: () => Promise<HibernationRouteDeps> = defaultRouteDeps
) {
  return {
    begin: createRoute(
      HIBERNATION_PATHS.begin,
      beginInput,
      async (body, deps) => beginAnswer(await beginHibernation(body, deps)),
      getDeps
    ),
    commit: createRoute(
      HIBERNATION_PATHS.commit,
      commitInput,
      async (body, deps) => commitAnswer(await commitHibernation(body, deps)),
      getDeps
    ),
    secrets: createRoute(
      HIBERNATION_PATHS.secrets,
      restoreSecretsInput,
      async (body, deps) => restoreSecretsAnswer(await restoreSleepingAppSecrets(body, deps)),
      getDeps
    ),
  };
}
