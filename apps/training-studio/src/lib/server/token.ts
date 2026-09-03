import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { orchestratorToken } from './orchestrator-token';

/** The caller's orchestrator token, or null when none can be resolved (dev preview without a pinned
 *  token, or a mint failure). Callers degrade — pricing shows "—", upload is refused — rather than
 *  throwing. The dev-login stub has no minted token, so a pinned ORCHESTRATOR_ACCESS_TOKEN (your API
 *  key) stands in and talks to the real orchestrator; quotes and blobs are user-agnostic. */
export async function resolveOrchestratorToken(locals: App.Locals): Promise<string | null> {
  if (locals.devPreview) return env.ORCHESTRATOR_ACCESS_TOKEN || null;
  try {
    return await orchestratorToken(locals.user.id);
  } catch (err) {
    console.warn('[training-studio] orchestratorToken failed', err);
    return null;
  }
}

/** Resolve the token or throw a 503 with the endpoint's own message. For the API routes that can't
 *  degrade — they need to actually call the orchestrator — so it narrows the result to a non-null token. */
export async function requireToken(
  locals: App.Locals,
  unavailableMessage: string
): Promise<string> {
  const token = await resolveOrchestratorToken(locals);
  if (token == null) error(503, unavailableMessage);
  return token;
}
