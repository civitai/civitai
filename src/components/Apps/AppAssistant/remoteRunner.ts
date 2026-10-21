import type { ChatRemoteRunner } from '@civitai/components-chat/civitai-chat';
import { runPaths } from '@civitai/components-chat/runner-protocol';

/**
 * Where the page reaches App Assistant's server runner (`apps/assistant-runner`): its run API on the
 * page's own origin, under the runner's `RUNNER_BASE_PATH`. Routing this path to the runner is the
 * deployment's job.
 */
export const ASSISTANT_RUNNER_BASE_PATH = '/api/assistant-runner';
export const RUNNER_VIEWER_TOKEN_ROUTE = '/api/apps/assistant/runner-viewer-token';
export const RUN_GRANT_ROUTE = '/api/apps/assistant/run-grant';
/** The header a start (and a patch) carries its run grant in; the runner's `GRANT_HEADER`. */
export const RUN_GRANT_HEADER = 'X-Run-Grant';

/** A viewer token this close to expiry is replaced rather than sent. */
const EXPIRY_MARGIN_MS = 60_000;

export class RunnerCredentialError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'RunnerCredentialError';
  }
}

export interface RunnerCredentials {
  /** The page's sign-in for the runner (`Authorization: Bearer`), cached until shortly before it expires. */
  viewerToken(): Promise<string>;
  /** A run grant for one start (or one patch) in `conversationId`, never cached: each start has its own. */
  grant(conversationId: string, idempotencyKey: string): Promise<string>;
}

async function readToken(
  res: Response,
  field: 'token' | 'grant'
): Promise<{ value: string; expiresAtMs: number }> {
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const value = data?.[field];
  if (!res.ok || typeof value !== 'string')
    throw new RunnerCredentialError(
      typeof data?.error === 'string' ? data.error : 'Could not reach the App Assistant runner',
      res.status,
      typeof data?.code === 'string' ? data.code : undefined
    );
  const expiresAtMs = typeof data?.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN;
  return { value, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0 };
}

/** The runner's credentials from civitai's session-authed routes, as `assistantToken.ts` gets App Assistant's. */
export function createRunnerCredentials({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
}: { fetchImpl?: typeof fetch; now?: () => number } = {}): RunnerCredentials {
  let cached: { value: string; expiresAtMs: number } | null = null;
  let inflight: Promise<string> | null = null;
  return {
    viewerToken() {
      if (cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > now())
        return Promise.resolve(cached.value);
      inflight ??= (async () => {
        cached = null;
        const res = await fetchImpl(RUNNER_VIEWER_TOKEN_ROUTE, {
          method: 'GET',
          credentials: 'same-origin',
        });
        cached = await readToken(res, 'token');
        return cached.value;
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    async grant(conversationId, idempotencyKey) {
      const query = new URLSearchParams({ conversationId, idempotencyKey });
      const res = await fetchImpl(`${RUN_GRANT_ROUTE}?${query}`, {
        method: 'GET',
        credentials: 'same-origin',
      });
      return (await readToken(res, 'grant')).value;
    },
  };
}

// The protocol's own paths, so a renamed route cannot quietly stop carrying its grant.
const START_PATH = runPaths.start();
const [PATCH_PREFIX, PATCH_SUFFIX] = runPaths.patch('\u0000').split('%00') as [string, string];

/** A random key for a grant that no start names (a patch's). */
function patchKey(): string {
  return `patch-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** The request a fetch is making, as the runner client calls it. */
function requestOf(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    typeof location === 'undefined' ? 'http://localhost/' : location.href
  );
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  return { path: url.pathname, method };
}

/**
 * `<civitai-chat>`'s `remoteRunner` for App Assistant. Every request carries the viewer token
 * (`headers()`, asked for before each request). The chat's `headers()` cannot tell which request it
 * signs, so the start (`POST runs`) gets its run grant here, in `fetch`, which sees the start's body
 * (its conversation and idempotency key); so does a patch, for its conversation. Following a run,
 * looking one up and stopping one carry the viewer token alone.
 */
export function createAppAssistantRemoteRunner({
  credentials,
  pageState,
  basePath = ASSISTANT_RUNNER_BASE_PATH,
  fetchImpl = (...args) => fetch(...args),
}: {
  credentials: RunnerCredentials;
  /** What the runner's tools need of the page as each reply starts: the app open in it. */
  pageState: () => { app: string | null };
  basePath?: string;
  fetchImpl?: typeof fetch;
}): ChatRemoteRunner {
  const base = basePath.replace(/\/+$/, '');
  return {
    url: base,
    headers: async () => ({ Authorization: `Bearer ${await credentials.viewerToken()}` }),
    pageState: () => ({ app: pageState().app }),
    fetch: async (input, init) => {
      const { path, method } = requestOf(input, init);
      let grant: string | undefined;
      try {
        if (method === 'POST' && path === `${base}/${START_PATH}`) {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            conversationId?: unknown;
            idempotencyKey?: unknown;
          };
          if (typeof body.conversationId === 'string' && typeof body.idempotencyKey === 'string')
            grant = await credentials.grant(body.conversationId, body.idempotencyKey);
        } else if (
          method === 'POST' &&
          path.startsWith(`${base}/${PATCH_PREFIX}`) &&
          path.endsWith(PATCH_SUFFIX)
        ) {
          const conversationId = decodeURIComponent(
            path.slice(`${base}/${PATCH_PREFIX}`.length, path.length - PATCH_SUFFIX.length)
          );
          if (conversationId) grant = await credentials.grant(conversationId, patchKey());
        }
      } catch (error) {
        // civitai would not grant it (the runner is off for this account, no consent): the chat shows
        // why as the runner's refusal, and does not ask again. A dropped request is asked again.
        if (!(error instanceof RunnerCredentialError)) throw error;
        const unauthorized = error.status === 401;
        return Response.json(
          { v: 1, error: unauthorized ? 'unauthorized' : 'refused', message: error.message },
          { status: unauthorized ? 401 : 403 }
        );
      }
      if (!grant) return fetchImpl(input, init);
      const headers = new Headers(init?.headers);
      headers.set(RUN_GRANT_HEADER, grant);
      return fetchImpl(input, { ...init, headers });
    },
  };
}

/**
 * The page's remote runner when the flag is on, else `undefined` (replies run in the browser). What
 * `AppAssistantWorkspace` hands `AppAssistantChat`.
 */
export function appAssistantRemoteRunnerFor(
  enabled: boolean,
  pageState: () => { app: string | null },
  credentials: () => RunnerCredentials = () => createRunnerCredentials()
): ChatRemoteRunner | undefined {
  return enabled
    ? createAppAssistantRemoteRunner({ credentials: credentials(), pageState })
    : undefined;
}

/**
 * Points the chat at the server runner, before `app` starts it. With none it assigns nothing at all,
 * so the chat runs replies in the browser exactly as it does without the feature.
 */
export function applyRemoteRunner(
  chat: { runner?: 'browser' | 'remote'; remoteRunner?: ChatRemoteRunner },
  remoteRunner: ChatRemoteRunner | undefined
): void {
  if (!remoteRunner) return;
  chat.runner = 'remote';
  chat.remoteRunner = remoteRunner;
}
