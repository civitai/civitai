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

/**
 * POST to the relay, retrying ONCE if it sheds with 429.
 *
 * The relay's memory cap sits deliberately below the batch sizes callers use, so a
 * 429 is an expected outcome for the very users this fallback exists for — a dropzone
 * batch of 10 against a cap of 8 sheds two. Without a retry the shed is terminal,
 * because the settlement rule reports the ORIGINAL upload error rather than the
 * relay's, so those files would fail permanently while the server was saying "try
 * again shortly".
 *
 * Retries ONCE and only on 429. Any other non-ok status is a real failure and is
 * surfaced; retrying it would just double the load that produced it.
 */
/** The bits of a response this helper reads. Generic so callers keep `Response`. */
type RetryableResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
};

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
    const seconds =
      Number.isFinite(advertised) && advertised > 0 ? advertised : opts.defaultRetryAfterSeconds;
    await opts.sleep(seconds * 1000);
    // A cancel during the backoff must not be spent on a second upload.
    if (opts.signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    response = await post();
  }
  return response;
}
