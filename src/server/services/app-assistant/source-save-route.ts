import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { getRunnerDevTunnelUser } from '~/server/services/app-assistant/app-assistant.service';
import { readRunnerRequest, runnerAppKey } from '~/server/services/app-assistant/runner-request';
import {
  saveAssistantSourceFromSandbox,
  type AssistantSaveResult,
} from '~/server/services/blocks/app-source-repo.service';

/**
 * What a save answers, for both callers (the page's session route and the runner's internal one).
 * `committed` carries the branch: `main`, or the assistant's own branch when `main` had the
 * developer's change to a file this save also changed (nothing of theirs was overwritten).
 */
export function sourceSaveAnswer(result: AssistantSaveResult): {
  status: number;
  json: Record<string, unknown>;
} {
  switch (result.kind) {
    case 'committed':
      return {
        status: 200,
        json: { saved: true, sha: result.sha, branch: result.branch, conflict: result.conflict },
      };
    case 'unchanged':
      return { status: 200, json: { saved: false, reason: 'unchanged' } };
    case 'not-running':
      return { status: 200, json: { saved: false, reason: 'not-running' } };
    case 'unavailable':
      return { status: 200, json: { saved: false, reason: 'unavailable' } };
    case 'busy':
      return { status: 409, json: { error: 'Another save of this app is running', code: 'busy' } };
    case 'too-large':
      return { status: 413, json: { error: result.message, code: 'too-large' } };
    case 'refused':
      // One answer for someone else's app and for a slug that cannot have a repo: no oracle.
      return { status: 404, json: { error: 'No app of yours under that key', code: 'NOT_FOUND' } };
  }
}

const runnerBody = z.object({ grant: z.string().min(1).max(4096), app: runnerAppKey });

/**
 * `POST /api/internal/app-assistant/source-save` — App Assistant's server runner asks civitai to
 * commit the open app to its source repo FOR the user its run grant names, after the assistant
 * changed the app's files. The gates are the runner's token mint's (`getRunnerDevTunnelUser`:
 * ban, onboarding, mute, email verification, the App Assistant flags, the author capability),
 * re-judged on every call; the files are read from the sandbox by civitai itself, as the user.
 */
export async function runnerSourceSaveRoute(req: AxiomAPIRequest, res: NextApiResponse) {
  const request = await readRunnerRequest(req, res, runnerBody, 'Expected { grant, app }');
  if (!request) return;
  const { grant, body } = request;
  try {
    const subject = await getRunnerDevTunnelUser(grant.userId);
    if (subject.refusal)
      return res
        .status(subject.refusal.status)
        .json({ error: subject.refusal.error, code: subject.refusal.code });
    const answer = sourceSaveAnswer(
      await saveAssistantSourceFromSandbox({ userId: grant.userId, app: body.app })
    );
    return res.status(answer.status).json(answer.json);
  } catch (err) {
    logToAxiom({
      type: 'app-assistant.runner-source-save.failed',
      message: `App Assistant runner source save failed for user ${grant.userId}`,
      userId: grant.userId,
      app: body.app,
      error: safeError(err),
    }).catch(() => undefined);
    return res.status(503).json({ error: 'Could not save the app right now', code: 'unavailable' });
  }
}
