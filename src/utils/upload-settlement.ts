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
    let relayPending = false;
    let settled = false;

    const settleResolve = (outcome: SettlementOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    xhr.addEventListener('loadend', () => {
      // A relay is in flight and owns settlement.
      if (relayPending) return;
      const success = xhr.readyState === 4 && xhr.status === 200;
      if (success) callbacks.onSuccess();
      settleResolve({ kind: 'direct', success });
    });

    xhr.addEventListener('error', () => {
      relayPending = true;
      relay()
        .then((relayedId) => {
          callbacks.onRelayed(relayedId);
          callbacks.onSuccess();
          settleResolve({ kind: 'relayed', id: relayedId });
        })
        .catch((relayError: unknown) => {
          // A cancel during the fallback is a cancel, not an upload failure.
          if (relayError instanceof DOMException && relayError.name === 'AbortError') {
            callbacks.onAborted();
            settleReject(new Error('Upload canceled'));
            return;
          }
          // Otherwise report the ORIGINAL failure. The fallback is a recovery
          // attempt; surfacing its error instead would rename the user's problem.
          callbacks.onError();
          settleReject(new Error(`Upload failed (status ${xhr.status})`));
        });
    });

    xhr.addEventListener('abort', () => {
      callbacks.onAborted();
      settleReject(new Error('Upload canceled'));
    });
  });
}
