import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';
import { appRateLimitMeta } from '~/server/utils/app-rate-limit';
import { getUsageLimitDef, usageLimits } from '~/shared/constants/usage-limits';
import { rateLimitMetaOf } from '~/server/utils/rate-limit-error';
import { sleepingAppSchema } from '~/server/schema/app-hibernation.schema';
import type { SessionUser } from '~/types/session';
import type { HibernationDeps } from '~/server/services/app-hibernation/app-hibernation.service';
import type {
  SleepingApp,
  WakeSeedResult,
} from '~/server/services/app-hibernation/sleeping-apps.service';

/**
 * APP HIBERNATE for App Assistant's server runner: the user's sleeping apps (`list_apps`,
 * `create_app`'s taken names) and the seed for waking one (`wake_app`), FOR the user the run
 * grant names. The grant is what the user's own request to civitai produced, so a wake ticket
 * minted here is minted from that user's request, as the page's `getWakeSeed` mints one.
 *
 * Answers, after `readRunnerRequest`'s:
 *   403 `refused` / `FORBIDDEN` an App Assistant gate refuses the user (`getRunnerDevTunnelUser`)
 *   404 `disabled`   the `app-hibernate` flag is off for the user: the runner offers no tools
 *   404 `NOT_FOUND`  no sleeping app of the user's under that key (wake only)
 *   409 `changed`    the record changed while the seed was made: ask again (wake only)
 *   429 `rate_limited` more than {@link RUNNER_SLEEPING_RATE_LIMIT} calls an hour for the user
 *   503 `not_configured` / `unavailable`
 * A PREVIEW grant (one Restart preview) is refused 403 before any of it, as the cover route does.
 */

/** Per user, per route: the page's own `getWakeSeed` limit (60 an hour). */
export const RUNNER_SLEEPING_RATE_LIMIT = usageLimits('apps.sleeping-reads');
/** The window of `apps.sleeping-reads`: the wait when the limiter names none. */
const RUNNER_SLEEPING_WINDOW_SECONDS = (() => {
  const { window } = getUsageLimitDef('apps.sleeping-reads');
  return window.type === 'rolling' ? window.seconds : 60 * 60;
})();

export type RunnerSleepingDeps = {
  /** The grant's user when every App Assistant gate admits them, else the refusal. */
  user: (
    userId: number
  ) => Promise<
    | { refusal: { status: number; error: string; code: string }; user?: undefined }
    | { refusal: null; user: SessionUser }
  >;
  enabled: (user: SessionUser) => Promise<boolean>;
  hibernation: () => Promise<HibernationDeps>;
  list: (userId: number, deps: HibernationDeps) => Promise<SleepingApp[]>;
  wakeSeed: (userId: number, app: string, deps: HibernationDeps) => Promise<WakeSeedResult>;
  /**
   * Counts one call for the user against {@link RUNNER_SLEEPING_RATE_LIMIT}: `true` within it; past
   * it the wait the limiter named (or `false` when it named none).
   */
  allow: (user: SessionUser) => Promise<true | false | { retryAfterSeconds: number }>;
};

type Answer = { status: number; json: unknown; retryAfterSeconds?: number };

const DISABLED: Answer = {
  status: 404,
  json: { error: 'Sleeping apps are not enabled', code: 'disabled' },
};

/** The gates both routes share: the user's App Assistant gates, then the flag. */
async function admitted(
  userId: number,
  deps: RunnerSleepingDeps
): Promise<{ answer: Answer } | { hibernation: HibernationDeps }> {
  const subject = await deps.user(userId);
  if (subject.refusal)
    return {
      answer: {
        status: subject.refusal.status,
        json: { error: subject.refusal.error, code: subject.refusal.code },
      },
    };
  if (!(await deps.enabled(subject.user))) return { answer: DISABLED };
  const allowed = await deps.allow(subject.user);
  if (allowed !== true) {
    const meta = appRateLimitMeta(
      'apps.sleeping-reads',
      allowed ? allowed.retryAfterSeconds : RUNNER_SLEEPING_WINDOW_SECONDS
    );
    return {
      answer: {
        status: 429,
        json: {
          error: 'Too many requests for your apps; try again later',
          code: 'rate_limited',
          rateLimit: meta,
        },
        retryAfterSeconds: meta.retryAfterSeconds,
      },
    };
  }
  return { hibernation: await deps.hibernation() };
}

export async function answerSleepingApps(
  userId: number,
  deps: RunnerSleepingDeps
): Promise<Answer> {
  const gate = await admitted(userId, deps);
  if ('answer' in gate) return gate.answer;
  return { status: 200, json: { apps: await deps.list(userId, gate.hibernation) } };
}

export async function answerWakeSeed(
  userId: number,
  app: string,
  deps: RunnerSleepingDeps
): Promise<Answer> {
  const gate = await admitted(userId, deps);
  if ('answer' in gate) return gate.answer;
  const result = await deps.wakeSeed(userId, app, gate.hibernation);
  switch (result.kind) {
    case 'ok':
      return { status: 200, json: result.seed };
    case 'not-found':
      return {
        status: 404,
        json: { error: 'No sleeping app of yours under that key', code: 'NOT_FOUND' },
      };
    case 'changed':
      return { status: 409, json: { error: 'The app was changing; ask again', code: 'changed' } };
    case 'disabled':
    case 'account-closed':
      return DISABLED;
    case 'not-configured':
      return {
        status: 503,
        json: { error: 'Sleeping apps are unavailable', code: 'not_configured' },
      };
  }
}

async function defaultDeps(req: AxiomAPIRequest, keyName: string): Promise<RunnerSleepingDeps> {
  const [
    { getRunnerDevTunnelUser },
    { isAppHibernateEnabled },
    { defaultHibernationDeps },
    svc,
    { claimRateLimitAttempt },
  ] = await Promise.all([
    import('~/server/services/app-assistant/app-assistant.service'),
    import('~/server/services/app-blocks-flag'),
    import('~/server/services/app-hibernation/hibernation-deps'),
    import('~/server/services/app-hibernation/sleeping-apps.service'),
    import('~/server/utils/rate-limit-bucket'),
  ]);
  return {
    allow: async (user) => {
      try {
        const record = await claimRateLimitAttempt({
          rules: RUNNER_SLEEPING_RATE_LIMIT,
          keyName,
          user,
          req,
        });
        await record();
        return true;
      } catch (err) {
        if (err instanceof TRPCError && err.code === 'TOO_MANY_REQUESTS') {
          const retryAfterSeconds = rateLimitMetaOf(err)?.retryAfterSeconds;
          return retryAfterSeconds ? { retryAfterSeconds } : false;
        }
        throw err;
      }
    },
    user: getRunnerDevTunnelUser,
    enabled: (user) => isAppHibernateEnabled({ user }),
    hibernation: defaultHibernationDeps,
    list: svc.listSleepingApps,
    wakeSeed: svc.getWakeSeed,
  };
}

const listBody = z.object({ grant: z.string().min(1).max(4096) });
const wakeBody = z.object({ grant: z.string().min(1).max(4096), app: sleepingAppSchema.shape.app });

async function respond(
  res: NextApiResponse,
  userId: number,
  what: string,
  answer: () => Promise<Answer>
) {
  try {
    const { status, json, retryAfterSeconds } = await answer();
    if (retryAfterSeconds) res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(status).json(json);
  } catch (err) {
    logToAxiom({
      type: `app-assistant.runner-${what}.failed`,
      message: `App Assistant runner ${what} failed for user ${userId}`,
      userId,
      error: safeError(err),
    });
    return res
      .status(503)
      .json({ error: 'Could not read your apps right now', code: 'unavailable' });
  }
}

/** A preview grant opens one live preview and nothing else. */
function refusePreview(res: NextApiResponse) {
  return res
    .status(403)
    .json({ error: 'A preview grant cannot read or wake apps', code: 'refused' });
}

/** `POST /api/internal/app-assistant/sleeping-apps` — `{ grant }` → `{ apps: SleepingApp[] }`. */
export async function runnerSleepingAppsRoute(req: AxiomAPIRequest, res: NextApiResponse) {
  const request = await readRunnerRequest(req, res, listBody, 'Expected { grant }');
  if (!request) return;
  if (request.grant.use === 'preview') return refusePreview(res);
  const userId = request.grant.userId;
  return respond(res, userId, 'sleeping-apps', async () =>
    answerSleepingApps(userId, await defaultDeps(req, 'app-assistant:runner-sleeping-apps'))
  );
}

/** `POST /api/internal/app-assistant/wake-seed` — `{ grant, app }` → `WakeSeed`. */
export async function runnerWakeSeedRoute(req: AxiomAPIRequest, res: NextApiResponse) {
  const request = await readRunnerRequest(req, res, wakeBody, 'Expected { grant, app }');
  if (!request) return;
  if (request.grant.use === 'preview') return refusePreview(res);
  const userId = request.grant.userId;
  // The page's getWakeSeed bucket: the page and the runner share the user's one quota.
  return respond(res, userId, 'wake-seed', async () =>
    answerWakeSeed(userId, request.body.app, await defaultDeps(req, 'appHibernation:getWakeSeed'))
  );
}
