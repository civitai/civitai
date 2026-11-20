import { env } from '$env/dynamic/private';
import { logToAxiom } from '$lib/server/axiom';

// The two orchestrator cache invalidations the hub makes, the same calls the main app makes when a
// user disconnects an app or changes its Buzz limit (src/server/services/orchestrator/civitai.ts and
// src/server/http/orchestrator/api-key-spend.ts). Best-effort: never throws, and a failure is logged.
// Unconfigured (ORCHESTRATOR_ENDPOINT or ORCHESTRATOR_ACCESS_TOKEN unset), each is a logged no-op and
// the orchestrator's caches simply age out.

const TIMEOUT_MS = 5_000;

async function orchestratorDelete(path: string, what: string): Promise<boolean> {
  const base = env.ORCHESTRATOR_ENDPOINT;
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!base || !token) {
    void logToAxiom({ type: 'info', name: 'orchestrator-cache-skipped', message: what });
    return false;
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 404: nothing cached, which is what we wanted.
    if (res.ok || res.status === 404) return true;
    throw new Error(`status ${res.status}`);
  } catch (err) {
    void logToAxiom({
      type: 'error',
      name: 'orchestrator-cache-invalidate-failed',
      message: `${what}: ${String(err)}`,
    });
    return false;
  }
}

/** Expire the orchestrator's cached authentication of this user's tokens. */
export function expireOrchestratorUserTokens(userId: number): Promise<boolean> {
  return orchestratorDelete(`/v2/consumer/civitai/${userId}/tokens`, 'user-tokens');
}

/** Drop the orchestrator's cached Buzz limit for this user's OAuth subject (the app's client id). */
export function bustOAuthBuzzLimitCache(userId: number, clientId: string): Promise<boolean> {
  return orchestratorDelete(
    `/v1/manager/users/${userId}/auth/oauth/${encodeURIComponent(clientId)}/limits`,
    'oauth-buzz-limit'
  );
}
