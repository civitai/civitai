/**
 * Settlement rule for a browser-direct upload that may fall back to a server relay.
 *
 * Extracted from `useCFImageUpload` so it can be tested for real. The defect this
 * exists to prevent is an ORDERING one, and ordering is not visible to any test that
 * re-implements the rule: per the XHR spec an `error` at the XHR object is followed
 * by `loadend` at the XHR object IN THE SAME DISPATCH, so a `loadend` handler that
 * settles unconditionally wins the race against an in-flight relay and resolves with
 * the presign id — a key holding no bytes — while also deleting the failure signal
 * the caller used to receive.
 *
 * The hook owns React state; this owns "who settles, and with what".
 */

/** The surface of XMLHttpRequest this rule touches — so a test can supply a stub. */
export type SettlementXhr = Pick<XMLHttpRequest, 'addEventListener' | 'readyState' | 'status'>;

export type SettlementOutcome =
  | { kind: 'direct'; success: boolean }
  | { kind: 'relayed'; id: string };

export type SettlementCallbacks = {
  /** Called when the relay produced the key that actually holds the bytes. */
  onRelayed: (id: string) => void;
  onSuccess: () => void;
  onError: () => void;
  onAborted: () => void;
};

/**
 * Wire the terminal XHR events and return a promise that settles exactly once.
 *
 * Resolves with the outcome, or rejects with the error the caller should surface.
 * `relay` is invoked only on a network-layer `error` — never on a non-2xx
 * `loadend`, which means we reached the backend and it rejected us; replaying those
 * bytes through a second route would mask a real fault rather than route around an
 * unreachable host.
 */
export function attachUploadSettlement(
  xhr: SettlementXhr,
  relay: () => Promise<string>,
  callbacks: SettlementCallbacks
): Promise<SettlementOutcome> {
  return new Promise<SettlementOutcome>((resolve, reject) => {
    // Set SYNCHRONOUSLY inside the `error` handler, so the `loadend` that follows in
    // the same dispatch observes it and yields. This flag is the entire fix.
    //
    // ⚠ There is deliberately NO second `settled` latch here. An earlier draft had
    // one; a round-2 audit measured it INERT — `resolve`/`reject` are already
    // idempotent, and the callbacks are gated by `relayPending`, so deleting the
    // latch left every test green. A guard that cannot fail is worse than none: it
    // reads as protection and stops the next person looking for the real one.
    let relayPending = false;

    xhr.addEventListener('loadend', () => {
      // A relay is in flight and owns settlement.
      if (relayPending) return;
      const success = xhr.readyState === 4 && xhr.status === 200;
      if (success) callbacks.onSuccess();
      resolve({ kind: 'direct', success });
    });

    xhr.addEventListener('error', () => {
      relayPending = true;
      relay()
        .then((relayedId) => {
          callbacks.onRelayed(relayedId);
          callbacks.onSuccess();
          resolve({ kind: 'relayed', id: relayedId });
        })
        .catch((relayError: unknown) => {
          // A cancel during the fallback is a cancel, not an upload failure.
          if (relayError instanceof DOMException && relayError.name === 'AbortError') {
            callbacks.onAborted();
            reject(new Error('Upload canceled'));
            return;
          }
          // Otherwise report the ORIGINAL failure. The fallback is a recovery
          // attempt; surfacing its error instead would rename the user's problem.
          callbacks.onError();
          reject(new Error(`Upload failed (status ${xhr.status})`));
        });
    });

    xhr.addEventListener('abort', () => {
      callbacks.onAborted();
      reject(new Error('Upload canceled'));
    });
  });
}

/** The bits of a response this helper reads. Generic so callers keep `Response`. */
type RetryableResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
};

/** Upper bound on an honoured `Retry-After`. A fallback upload is interactive. */
export const MAX_RETRY_AFTER_SECONDS = 10;

/**
 * POST to the relay, retrying ONCE if it sheds with 429.
 *
 * Without a retry a shed is TERMINAL: the settlement rule deliberately reports the
 * ORIGINAL upload error rather than the relay's, so a shed file would fail
 * permanently while the server was saying "try again shortly".
 *
 * ⚠ An earlier version of this comment justified the retry by claiming a dropzone
 * batch of 10 against a per-pod cap of 8 routinely sheds two. That was wrong — the
 * cap is per POD, the pool's replica floor is in the dozens, and there is no session
 * affinity, so one browser's concurrent POSTs spread across pods. A shed is an
 * ANOMALY, not routine. The retry is still worth having (it is cheap, and a lost
 * upload is not), but do not read a 429 here as business as usual.
 *
 * Retries ONCE and only on 429. Any other non-ok status is a real failure and is
 * surfaced; retrying it would just double the load that produced it.
 *
 * 🔴 The delay is CLAMPED, and the wait is CANCELLABLE. `Retry-After` is remote input
 * and this retry fires on ANY 429, not only our own relay's shed — a CDN or an edge
 * rate-limiter in front of us can answer 429 with a `Retry-After` of an hour. Without
 * the clamp the hook would sit on the user's `File` for that hour with the tracked
 * file stuck at `uploading`; without the abort race the cancel button would be inert
 * for the whole wait, because the abort check only runs AFTER the sleep resolves.
 */
export async function relayWithRetry<T extends RetryableResponse>(
  post: () => Promise<T>,
  opts: {
    signal: AbortSignal;
    sleep: (ms: number) => Promise<void>;
    defaultRetryAfterSeconds: number;
  }
): Promise<T> {
  let response = await post();
  if (response.status === 429) {
    const advertised = Number(response.headers.get('Retry-After'));
    const requested =
      Number.isFinite(advertised) && advertised > 0 ? advertised : opts.defaultRetryAfterSeconds;
    const seconds = Math.min(requested, MAX_RETRY_AFTER_SECONDS);

    // Race the wait against cancellation, so an abort mid-backoff is observed when it
    // happens rather than whenever the timer would have expired.
    await Promise.race([
      opts.sleep(seconds * 1000),
      new Promise<void>((_, rejectWait) => {
        if (opts.signal.aborted) return rejectWait(abortError());
        opts.signal.addEventListener('abort', () => rejectWait(abortError()), { once: true });
      }),
    ]);

    // Also covers a sleep that resolved normally on an already-aborted signal.
    if (opts.signal.aborted) throw abortError();
    response = await post();
  }
  return response;
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}
