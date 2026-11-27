import { env } from '~/env/server';

/** The orchestrator system token; throws when it is not configured. */
export function systemOrchestratorToken(): string {
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!token) throw new Error('ORCHESTRATOR_ACCESS_TOKEN is not configured');
  return token;
}
