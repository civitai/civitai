import { env } from '$env/dynamic/private';
import type { WorkflowCallback } from '@civitai/client';
import { WORKFLOW_UPDATE_SIGNAL } from '$lib/signal-events';

function base(): string | undefined {
  return env.SIGNALS_ENDPOINT?.replace(/\/+$/, '');
}

/** Mint a short-lived SignalR access token for the user, server-side (no browser CORS — same pattern as
 *  the buzz balance read). Returns null on any failure or when signals aren't configured, so the client
 *  simply doesn't connect and polling stays the source of truth. */
export async function getSignalsAccessToken(userId: number): Promise<string | null> {
  const endpoint = base();
  if (!endpoint) return null;
  try {
    const res = await fetch(`${endpoint}/users/${userId}/accessToken`);
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken?: string | null };
    return data.accessToken ?? null;
  } catch {
    return null;
  }
}

/** Orchestrator callback that makes a training workflow emit `workflow-update` signals to this user as its
 *  steps progress — the push that lets the detail page refresh without the 5s poll. Undefined when signals
 *  aren't configured (the submit then behaves exactly as before: poll-only). Mirrors the main app's
 *  `getWorkflowCallbacks`. */
export function workflowSignalCallbacks(userId: number): WorkflowCallback[] | undefined {
  const endpoint = base();
  if (!endpoint) return undefined;
  return [
    { url: `${endpoint}/users/${userId}/signals/${WORKFLOW_UPDATE_SIGNAL}`, type: ['step:*'] },
  ];
}
