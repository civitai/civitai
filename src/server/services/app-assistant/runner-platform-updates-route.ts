import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import {
  answerPlatformUpdateResolve,
  answerPlatformUpdates,
  type Answer,
  type RunnerPlatformUpdateDeps,
} from '~/server/services/app-assistant/runner-platform-updates';
import { readRunnerRequest, runnerAppKey } from '~/server/services/app-assistant/runner-request';

/**
 * The runner's platform-update routes (contract: `runner-platform-updates.ts`). The owner API they
 * call is `app-platform-update.service.ts`.
 */

async function defaultDeps(): Promise<RunnerPlatformUpdateDeps> {
  const [
    { getRunnerDevTunnelUser },
    { getFeatureFlagsAsync },
    updates,
    forgejo,
    { FORGEJO_SOURCE_ORG },
    sourceRepo,
  ] = await Promise.all([
    import('~/server/services/app-assistant/app-assistant.service'),
    import('~/server/services/feature-flags.service'),
    import('~/server/services/blocks/app-platform-update.service'),
    import('~/server/services/blocks/forgejo.service'),
    import('~/server/services/blocks/forgejo-orgs'),
    import('~/server/services/blocks/app-source-repo.service'),
  ]);
  return {
    user: getRunnerDevTunnelUser,
    enabled: async (user) =>
      !!(await getFeatureFlagsAsync({ user })).appBlocks &&
      (await updates.isPlatformUpdatesEnabled()),
    listPending: ({ userId, slug }) =>
      updates.listPendingPlatformUpdates({ userId, app: { slug } }),
    verifyCommit: ({ userId, slug, commitSha }) =>
      updates.verifyPlatformUpdateCommit({ userId, app: { slug }, commitSha }),
    resolve: (args) => updates.resolvePlatformUpdate(args),
    treeAt: (slug, commitSha) => forgejo.listRepoTreeAtRef(slug, commitSha, FORGEJO_SOURCE_ORG),
    blob: (slug, blobSha) => forgejo.getBlobContent(slug, blobSha, FORGEJO_SOURCE_ORG),
    save: ({ userId, app }) =>
      sourceRepo.saveAssistantSourceFromSandbox({ userId, app, impersonatedBy: null }),
    lastSave: async (slug) => {
      const { row } = await sourceRepo.readSourceRepo(slug);
      return row ? { sha: row.lastAssistantCommitSha, branch: row.lastAssistantBranch } : null;
    },
  };
}

const grant = z.string().min(1).max(4096);
const listBody = z.object({ grant, app: runnerAppKey });
const resolveBody = z.object({
  grant,
  app: runnerAppKey,
  id: z.string().min(1).max(64),
  commitSha: z.string().min(40).max(64),
  outcome: z.enum(['merged', 'conflicted']),
});

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
    });
    return res
      .status(503)
      .json({ error: 'Could not read platform updates right now', code: 'unavailable' });
  }
}

function refusePreview(res: NextApiResponse) {
  return res
    .status(403)
    .json({ error: 'A preview grant cannot read platform updates', code: 'refused' });
}

/** `POST /api/internal/app-assistant/platform-updates`. */
export async function runnerPlatformUpdatesRoute(req: AxiomAPIRequest, res: NextApiResponse) {
  const request = await readRunnerRequest(req, res, listBody, 'Expected { grant, app }');
  if (!request) return;
  if (request.grant.use === 'preview') return refusePreview(res);
  const userId = request.grant.userId;
  return respond(res, userId, 'platform-updates', async () =>
    answerPlatformUpdates(userId, request.body.app, await defaultDeps())
  );
}

/** `POST /api/internal/app-assistant/platform-updates/resolve`. */
export async function runnerPlatformUpdateResolveRoute(req: AxiomAPIRequest, res: NextApiResponse) {
  const request = await readRunnerRequest(
    req,
    res,
    resolveBody,
    'Expected { grant, app, id, commitSha, outcome }'
  );
  if (!request) return;
  if (request.grant.use === 'preview') return refusePreview(res);
  const userId = request.grant.userId;
  const { app, id, commitSha, outcome } = request.body;
  return respond(res, userId, 'platform-update-resolve', async () =>
    answerPlatformUpdateResolve(userId, { app, id, commitSha, outcome }, await defaultDeps())
  );
}
