import type { ChatRemoteRunner } from '@civitai/components-chat/civitai-chat';
import { runPaths } from '@civitai/components-chat/runner-protocol';
import {
  previewGrantConversation,
  runnerPreviewOf,
  type ShownPreview,
} from '@civitai/app-assistant';

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
  /**
   * A run grant for one start (or one patch) in `conversationId`, never cached: each start has its
   * own. With `purpose` `preview`, a short-lived preview grant for one Restart preview instead.
   */
  grant(conversationId: string, idempotencyKey: string, purpose?: 'preview'): Promise<string>;
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
    async grant(conversationId, idempotencyKey, purpose) {
      const query = new URLSearchParams({
        conversationId,
        idempotencyKey,
        ...(purpose ? { purpose } : {}),
      });
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

/** A random key for a grant that no start names (a patch's, a Restart preview's). */
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

/** The runner's Restart preview for `app`, under the base path (its `POST apps/:app/preview`). */
export function runnerPreviewPath(app: string): string {
  return `apps/${encodeURIComponent(app)}/preview`;
}

/** What the page shows when a Restart preview fails without the runner saying why. */
export const RESTART_PREVIEW_FAILED =
  'The preview could not start just now. Try again in a moment.';

/** The runner (or civitai, for the grant) would not restart the preview; `message` is for the user. */
export class RunnerPreviewError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'RunnerPreviewError';
  }
}

/**
 * Asks the server runner to open `app`'s live preview again, with no reply (no model call, no Buzz):
 * the page's Restart preview, after a reload found none live. Signed with the viewer token and a
 * preview grant for this app, which civitai signs for the user. Answers the block and the host the
 * pane shows (never the tunnel's id), or throws `RunnerPreviewError` with the words to show.
 */
export async function restartRunnerPreview(
  app: string,
  {
    credentials,
    basePath = ASSISTANT_RUNNER_BASE_PATH,
    fetchImpl = (...args) => fetch(...args),
  }: { credentials: RunnerCredentials; basePath?: string; fetchImpl?: typeof fetch }
): Promise<ShownPreview> {
  let viewer: string;
  let grant: string;
  try {
    viewer = await credentials.viewerToken();
    grant = await credentials.grant(previewGrantConversation(app), patchKey(), 'preview');
  } catch (error) {
    if (error instanceof RunnerCredentialError)
      throw new RunnerPreviewError(error.message, error.status, error.code);
    throw new RunnerPreviewError(RESTART_PREVIEW_FAILED, 503);
  }
  let res: Response;
  try {
    res = await fetchImpl(`${basePath.replace(/\/+$/, '')}/${runnerPreviewPath(app)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${viewer}`,
        [RUN_GRANT_HEADER]: grant,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ v: 1 }),
    });
  } catch {
    throw new RunnerPreviewError(RESTART_PREVIEW_FAILED, 503);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const shown = res.ok ? runnerPreviewOf(data) : null;
  if (shown) return shown;
  throw new RunnerPreviewError(
    // Only the runner's own refusals (`v: 1`) carry words for the user: an older runner without
    // this route answers Fastify's 404, whose message names the route.
    !res.ok && data?.v === 1 && typeof data.message === 'string' && data.message
      ? data.message
      : RESTART_PREVIEW_FAILED,
    res.ok ? 503 : res.status,
    typeof data?.error === 'string' ? data.error : undefined
  );
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
