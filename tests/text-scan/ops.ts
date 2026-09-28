import type { APIRequestContext } from '@playwright/test';
import { e2eEnv } from './env';
import { jobRunError } from './logic';
import { trpcQuery } from './trpc';
import { waitFor } from './wait';

export async function runJob(name: string) {
  const env = e2eEnv();
  const res = await fetch(
    `${env.TEXT_SCAN_E2E_BASE_URL}/api/webhooks/run-jobs/${encodeURIComponent(
      name
    )}?token=${encodeURIComponent(env.WEBHOOK_TOKEN)}`,
    { signal: AbortSignal.timeout(300_000) }
  );
  const body: unknown = await res.json().catch(() => null);
  const error = jobRunError(name, res.status, body);
  if (error) throw new Error(error);
  return (body as { result: unknown }).result;
}

/** The local testing route; `scanEntity`/`batchEntities` block on the orchestrator for up to `wait` seconds each. */
export async function harness<T = unknown>(
  body: Record<string, unknown>,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  const env = e2eEnv();
  const res = await fetch(
    `${env.TEXT_SCAN_E2E_BASE_URL}/api/testing/chat-completion-scan?token=${encodeURIComponent(
      env.WEBHOOK_TOKEN
    )}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `harness ${String(body.action)} -> HTTP ${res.status}: ${JSON.stringify(json).slice(0, 600)}`
    );
  return json as T;
}

type NotificationItem = { type: string; details: Record<string, unknown>; createdAt: string };

/** Test users are fresh, so a type match is this test's notification. */
export async function waitForNotification(
  api: APIRequestContext,
  type: string,
  match?: (n: NotificationItem) => boolean
) {
  return waitFor(
    `notification ${type}`,
    async () => {
      const { data } = await trpcQuery<{ items: NotificationItem[] }>(
        api,
        'notification.getAllByUser',
        { limit: 50 }
      );
      const found = data?.items.find((n) => n.type === type && (!match || match(n)));
      return found
        ? { done: true, value: found }
        : { done: false, observed: data?.items.map((n) => n.type) };
    },
    { timeoutMs: 120_000, intervalMs: 3_000 }
  );
}
