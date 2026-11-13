import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';
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
 *   503 `not_configured` / `unavailable`
 */

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
};

type Answer = { status: number; json: unknown };

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

async function defaultDeps(): Promise<RunnerSleepingDeps> {
  const [{ getRunnerDevTunnelUser }, { isAppHibernateEnabled }, { defaultHibernationDeps }, svc] =
    await Promise.all([
      import('~/server/services/app-assistant/app-assistant.service'),
      import('~/server/services/app-blocks-flag'),
      import('~/server/services/app-hibernation/hibernation-deps'),
      import('~/server/services/app-hibernation/sleeping-apps.service'),
    ]);
  return {
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
    const { status, json } = await answer();
    return res.status(status).json(json);
  } catch (err) {
    logToAxiom({
      type: `app-assistant.runner-${what}.failed`,
      message: `App Assistant runner ${what} failed for user ${userId}`,
      userId,
      error: safeError(err),
    }).catch(() => undefined);
    return res
      .status(503)
      .json({ error: 'Could not read your apps right now', code: 'unavailable' });
  }
}

/** `POST /api/internal/app-assistant/sleeping-apps` — `{ grant }` → `{ apps: SleepingApp[] }`. */
export async function runnerSleepingAppsRoute(req: AxiomAPIRequest, res: NextApiResponse) {
  const request = await readRunnerRequest(req, res, listBody, 'Expected { grant }');
  if (!request) return;
  const userId = request.grant.userId;
  return respond(res, userId, 'sleeping-apps', async () =>
    answerSleepingApps(userId, await defaultDeps())
  );
}

/** `POST /api/internal/app-assistant/wake-seed` — `{ grant, app }` → `WakeSeed`. */
export async function runnerWakeSeedRoute(req: AxiomAPIRequest, res: NextApiResponse) {
  const request = await readRunnerRequest(req, res, wakeBody, 'Expected { grant, app }');
  if (!request) return;
  const userId = request.grant.userId;
  return respond(res, userId, 'wake-seed', async () =>
    answerWakeSeed(userId, request.body.app, await defaultDeps())
  );
}
