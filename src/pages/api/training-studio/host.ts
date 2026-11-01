import { env } from '~/env/server';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';

/**
 * Host side of the embedded Training Studio (docs/training-studio-web-component.md).
 *
 * GET → { token, orchestratorMode } for the CALLER — /training-studio implements the element's
 * `getOrchestratorToken()` provider with this. No params; no side effects beyond the token cache
 * getOrchestratorToken already keeps. The orchestrator URL is NOT part of the response — see the
 * note at the `res.json` below.
 *
 * The token spends Buzz orchestrator-side, so the caller must pass the Studio's gates first
 * (`allowTrainingStudio`).
 */
export default AuthedEndpoint(async (req, res, user) => {
  if (!(await allowTrainingStudio(req, res, user))) return;

  const token = await getOrchestratorToken(user.id, { req, res });
  // In ORCHESTRATOR_MODE=dev getOrchestratorToken returns the SHARED service credential, which must
  // never reach a browser. Refuse unless local dev explicitly opted in.
  if (
    env.ORCHESTRATOR_ACCESS_TOKEN &&
    token === env.ORCHESTRATOR_ACCESS_TOKEN &&
    !env.ALLOW_DEV_ORCHESTRATOR_TOKEN_PASSTHROUGH
  )
    return res.status(500).json({
      error:
        'Refusing to send the shared dev orchestrator token to the browser. Set ALLOW_DEV_ORCHESTRATOR_TOKEN_PASSTHROUGH=true for local development.',
    });

  res.setHeader('Cache-Control', 'no-store');
  // 🔴 No `orchestratorEndpoint` here, deliberately. It used to return `env.ORCHESTRATOR_ENDPOINT`,
  // which is the in-cluster address — a value that must never reach a browser, for the same reason
  // the dev-token guard above exists. Nothing consumed it (the only caller, /training-studio, reads
  // `.token` alone), so it was a leak with no purpose. The browser gets the PUBLIC origin from
  // `NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT` instead. Do not re-add it from the server env.
  res.json({
    token,
    orchestratorMode: env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod',
  });
});
