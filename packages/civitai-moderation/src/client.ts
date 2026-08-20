import {
  MOD_ACTION,
  imageModerateInput,
  type ImageModerateInput,
  type ModActionName,
} from './schema';

export type ModeratorClientConfig = {
  /** Base URL of the moderator spoke app, e.g. `https://moderator.civitai.com`. Falls back to
   * `process.env.MODERATOR_APP_URL`. */
  endpoint?: string;
  /** Shared internal secret for the `/api/mod/*` ingress (the same WEBHOOK_TOKEN syncSearchIndex uses).
   * Falls back to `process.env.WEBHOOK_TOKEN`. */
  token?: string;
  /** Override fetch (tests / non-global-fetch runtimes). */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 15s. */
  timeoutMs?: number;
  /** Called once per request failure, from the single `call()` choke point — wire to your logger. */
  onFailure?: (failure: { action: string; status?: number; message: string }) => void;
};

export class ModeratorClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ModeratorClientError';
  }
}

/**
 * Build a client for the moderator spoke's `/api/mod/*` actions. The spoke OWNS these mutations; the main
 * app calls this to delegate them. Deliberately does NOT retry: moderator mutations aren't idempotent (a
 * retry would double-write DeleteTOS rows / notifications / blocklist entries), so a failure surfaces to
 * the caller to decide.
 */
export function createModeratorClient(config: ModeratorClientConfig = {}) {
  const doFetch = config.fetch ?? fetch;

  async function call(action: ModActionName, body: unknown): Promise<unknown> {
    const endpoint = (config.endpoint ?? process.env.MODERATOR_APP_URL ?? '').replace(/\/$/, '');
    const token = config.token ?? process.env.WEBHOOK_TOKEN;
    try {
      const res = await doFetch(`${endpoint}/api/mod/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs ?? 15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // SvelteKit `error(status, message)` responds with `{"message": "..."}` — surface that clean
        // message when present (so a 4xx like a conflicting verdict reads well), else the raw body.
        let detail = text;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed.message === 'string') detail = parsed.message;
        } catch {
          // not JSON — keep the raw text
        }
        throw new ModeratorClientError(
          detail || `moderator action "${action}" failed: ${res.status}`,
          res.status
        );
      }
      return await res.json().catch(() => ({}));
    } catch (e) {
      const err =
        e instanceof ModeratorClientError
          ? e
          : new ModeratorClientError(
              `moderator action "${action}" failed: ${(e as Error).message}`
            );
      config.onFailure?.({ action, status: err.status, message: err.message });
      throw err;
    }
  }

  return {
    call,
    /** Block or unblock one or more images. Validates the payload locally before the network call. */
    imageModerate: (input: ImageModerateInput): Promise<unknown> =>
      call(MOD_ACTION.imageModerate, imageModerateInput.parse(input)),
  };
}

export type ModeratorClient = ReturnType<typeof createModeratorClient>;
