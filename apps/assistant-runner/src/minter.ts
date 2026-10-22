import { createHash } from 'node:crypto';

import type { Logger } from './interfaces';

/**
 * What a minted token is for, as civitai's `AppAssistantTokenPurpose`: `chat` spends Buzz through
 * orchestration (model calls and the conversation store); `sandbox` only says who the user is, to the
 * hosted sandbox service and its MCP server (the sandbox tools).
 */
export type TokenPurpose = 'chat' | 'sandbox';

/** The civitai endpoint the runner trades a grant at, relative to `CIVITAI_URL`. */
export const MINT_PATH = 'api/internal/app-assistant/runner-token';
/** A token this close to expiry is minted again rather than used. */
const EXPIRY_MARGIN_MS = 60_000;
/**
 * The longest one token is used, however long it is valid: every mint re-checks the user's gates and
 * the runner's flag, so a ban, a revoked consent or the runner turned off lands within about this.
 */
export const MAX_TOKEN_REUSE_MS = 60_000;
const MINT_TIMEOUT_MS = 15_000;
/** The most tokens kept in memory; past it, expired ones are dropped first, then the oldest. */
const MAX_CACHED = 5_000;

/**
 * Why civitai would not mint. `refused` (a gate refused the user: banned, restricted, the feature
 * off) and `consent_required` (they turned the assistant off) end the reply for good;
 * `invalid_grant` too; only `unavailable` is worth asking again.
 */
export class MintRefusedError extends Error {
  override name = 'MintRefusedError';
  constructor(
    readonly code: 'refused' | 'consent_required' | 'invalid_grant' | 'unavailable',
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface MinterOptions {
  civitaiUrl: string;
  /** The runner's own secret, which civitai checks on every mint. */
  secret: string;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Cached {
  token: string;
  expiresAtMs: number;
}

/**
 * Trades a run grant, with the runner's secret, for a short-lived civitai token of one purpose, and
 * keeps it in this process's memory until shortly before it expires. Tokens are never written
 * anywhere and never logged; concurrent callers for the same grant and purpose share one mint.
 */
export class TokenMinter {
  readonly #options: MinterOptions;
  readonly #cache = new Map<string, Cached>();
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(options: MinterOptions) {
    this.#options = options;
  }

  /**
   * `signal` ends this caller's wait (a Stop), not the mint itself, which other callers for the same
   * grant may share and which its own timeout bounds.
   */
  async token(
    grant: string,
    purpose: TokenPurpose,
    { fresh = false, signal }: { fresh?: boolean; signal?: AbortSignal } = {}
  ): Promise<string> {
    const key = `${purpose}:${createHash('sha256').update(grant).digest('base64url')}`;
    const now = this.#now();
    const hit = this.#cache.get(key);
    if (!fresh && hit && hit.expiresAtMs - EXPIRY_MARGIN_MS > now) return hit.token;
    let pending = this.#inflight.get(key);
    if (!pending) {
      this.#cache.delete(key);
      pending = this.#mint(grant, purpose, key).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return signal ? untilAborted(pending, signal) : pending;
  }

  async #mint(grant: string, purpose: TokenPurpose, key: string): Promise<string> {
    const { civitaiUrl, secret, log } = this.#options;
    const doFetch = this.#options.fetch ?? fetch;
    const url = `${civitaiUrl.replace(/\/+$/, '')}/${MINT_PATH}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ grant, purpose }),
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
    } catch (error) {
      log.warn({ purpose, err: (error as Error)?.name }, 'minting a token failed');
      throw new MintRefusedError('unavailable', 'Civitai could not be reached just now.', 503);
    }
    const body = (await response.json().catch(() => null)) as {
      token?: unknown;
      expiresAt?: unknown;
      code?: unknown;
      error?: unknown;
    } | null;
    if (!response.ok || typeof body?.token !== 'string') {
      if (body?.code === 'consent_required') {
        log.warn({ purpose, status: response.status }, 'civitai refused to mint: consent is gone');
        throw new MintRefusedError(
          'consent_required',
          'App Assistant is turned off for this account. Turn it on to continue.',
          403
        );
      }
      if (body?.code === 'invalid_grant') {
        log.warn({ purpose, status: response.status }, 'civitai refused to mint: the grant');
        throw new MintRefusedError(
          'invalid_grant',
          'This reply can no longer act for you. Send your message again.',
          401
        );
      }
      if (body?.code === 'refused') {
        log.warn(
          { purpose, status: response.status },
          'civitai refused to mint: the user is refused'
        );
        throw new MintRefusedError(
          'refused',
          typeof body.error === 'string' && body.error
            ? body.error
            : 'App Assistant is not available on this account.',
          403
        );
      }
      // A 401 or 403 with neither code is civitai refusing the runner itself (its secret): a
      // deployment fault, not the user's, so it is logged as one.
      if (response.status === 401 || response.status === 403)
        log.error({ purpose, status: response.status }, 'civitai refused the runner secret');
      else log.warn({ purpose, status: response.status }, 'civitai could not mint a token');
      throw new MintRefusedError('unavailable', 'Civitai could not be reached just now.', 503);
    }
    const expiresAtMs = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
    // Kept as if it expired a minute (plus the margin) from now at the latest.
    const reuseUntil = this.#now() + MAX_TOKEN_REUSE_MS + EXPIRY_MARGIN_MS;
    this.#remember(key, {
      token: body.token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? Math.min(expiresAtMs, reuseUntil) : 0,
    });
    return body.token;
  }

  #remember(key: string, value: Cached): void {
    if (this.#cache.size >= MAX_CACHED) {
      const now = this.#now();
      for (const [k, v] of this.#cache) if (v.expiresAtMs <= now) this.#cache.delete(k);
      while (this.#cache.size >= MAX_CACHED) {
        const oldest = this.#cache.keys().next().value;
        if (oldest === undefined) break;
        this.#cache.delete(oldest);
      }
    }
    this.#cache.set(key, value);
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}

/**
 * Where a provider gets a token of a purpose; `fresh` skips the cached one (after a 401), `signal`
 * stops waiting for it.
 */
export type TokenSource = (
  purpose: TokenPurpose,
  options?: { fresh?: boolean; signal?: AbortSignal }
) => Promise<string>;

/** `promise`, or a rejection as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
