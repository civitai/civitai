import {
  MOD_ACTION,
  abuseReportInput,
  imageModerateInput,
  relabelBuildBatchInput,
  type AbuseReportInput,
  type ImageModerateInput,
  type ModActionName,
  type RelabelBuildBatchInput,
} from './schema';

export type ModeratorClientConfig = {
  /** Base URL of the moderator spoke app, e.g. `https://moderator.civitai.com`. Falls back to
   * `process.env.MODERATOR_APP_URL`. */
  endpoint?: string;
  /** Credential for the `/api/mod/*` ingress. 🔴 PASS THIS EXPLICITLY. The spoke accepts only
   * `MOD_INBOUND_TOKEN`; `WEBHOOK_TOKEN` was dropped from its accepted set, so the
   * `process.env.WEBHOOK_TOKEN` fallback below now yields a credential the server REFUSES (401).
   * The fallback is kept only so an existing caller does not change shape on this commit — it is
   * not a working default, and a new integrator should not rely on it. */
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

  async function call(
    action: ModActionName,
    body: unknown,
    { timeoutMs = config.timeoutMs ?? 15_000 }: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    const endpoint = (config.endpoint ?? process.env.MODERATOR_APP_URL ?? '').replace(/\/$/, '');
    const token = config.token ?? process.env.WEBHOOK_TOKEN;
    try {
      const res = await doFetch(`${endpoint}/api/mod/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? ''}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
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
    /**
     * File one run of an automated abuse detector on the moderation board.
     *
     * `.parse` rather than a hand-rolled body, and that is the point of having a method here at all:
     * the receiving table carries CHECK constraints whose violation aborts the transaction and loses
     * the WHOLE run, so a malformed finding must be refused on the producer's side of the wire — a
     * thrown ZodError names the offending field, where a 400 from the spoke names only the request.
     * A producer that reaches for `call(MOD_ACTION.abuseReport, …)` directly skips that.
     *
     * Write-only, like the endpoint behind it: this stores what a detector found and grants nothing.
     * It cannot mute, exclude or ban, and adding a method here can never make it able to.
     */
    abuseReport: (input: AbuseReportInput): Promise<unknown> =>
      call(MOD_ACTION.abuseReport, abuseReportInput.parse(input)),
    /**
     * Build the day's removal-label relabel batch, which takes far longer than the default timeout.
     * An abort here does not stop the spoke, so it can record a failure for a run that completed;
     * this timeout avoids that only if the ingress in between allows as long.
     */
    relabelBuildBatch: (input: RelabelBuildBatchInput): Promise<unknown> =>
      call(MOD_ACTION.relabelBuildBatch, relabelBuildBatchInput.parse(input), {
        timeoutMs: 5 * 60_000,
      }),
  };
}

export type ModeratorClient = ReturnType<typeof createModeratorClient>;
