import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describePartFailure,
  getPartRetryDelay,
  isTerminalCompleteStatus,
  RELAY_FALLBACK_MAX_BYTES,
  resolveUploadRowStatus,
  shouldRelayOnPartFailure,
} from '~/utils/upload-retry';

/**
 * `isTerminalCompleteStatus` is the ONE place both upload clients decide whether a
 * `/api/upload/complete` response may be re-POSTed.
 *
 * 🔴 Why it is tested here rather than only through a client: the predicate was
 * open-coded in `s3-upload.store.ts` and MISSING from `useS3Upload.tsx`, which has no
 * test file at all — so the store's behavioural test could stay green while the hook
 * retried a terminal status 4 times, 200 ms apart. Pinning the shared predicate is what
 * makes the hook's copy of the rule covered, because it no longer has a copy.
 */
describe('isTerminalCompleteStatus', () => {
  it.each([
    // The multipart session is already finalized or aborted.
    [409, true],
    // The upload STATE is bad: an unacceptable parts manifest, or a completion whose
    // object could not be verified. Re-sending the same manifest cannot fix either.
    [422, true],
  ])('treats %i as terminal', (status, expected) => {
    expect(isTerminalCompleteStatus(status)).toBe(expected);
  });

  it.each([
    // Retryable: a genuine transient backend fault.
    [503, false],
    [500, false],
    // Not terminal-by-contract — these must keep their existing retry behaviour rather
    // than being silently swallowed as final.
    [429, false],
    [408, false],
    [401, false],
    [400, false],
    // Success is not "terminal failure"; the callers gate on !res.ok first, but the
    // predicate must not claim a 2xx is terminal if that order ever changes.
    [200, false],
  ])('does not treat %i as terminal', (status, expected) => {
    expect(isTerminalCompleteStatus(status)).toBe(expected);
  });

  // 🔴 An enumerated ledger, not a spot check: if a status is ADDED to or REMOVED from
  // the terminal set, this fails and forces both clients' behaviour to be reconsidered
  // together — which is the whole point of the predicate living in one module.
  it('the terminal set is exactly {409, 422}', () => {
    const terminal = Array.from({ length: 600 }, (_, i) => i)
      .filter((s) => s >= 100)
      .filter(isTerminalCompleteStatus);
    expect(terminal).toEqual([409, 422]);
  });
});

/**
 * The backoff POLICY is only observable through the store as elapsed wall clock, so it had no
 * cover at all: making 429 and 5xx non-retryable left every s3-upload.store test green. Pinned
 * here, where the numbers can be read directly instead of waited for.
 */
describe('getPartRetryDelay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('grows exponentially with the attempt, so a struggling backend gets backed off', () => {
    const delays = [0, 1, 2].map((attempt) => getPartRetryDelay({ status: 503 }, attempt));
    // ~1s, 2s, 4s, each plus up to 1s of jitter — asserted as bands, since the jitter is random.
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThan(2000);
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
    expect(delays[1]).toBeLessThan(3000);
    expect(delays[2]).toBeGreaterThanOrEqual(4000);
    expect(delays[2]).toBeLessThan(5000);
  });

  it('caps at a minute however many attempts have gone by', () => {
    // Without a ceiling, attempt 20 is 2^20 seconds — the upload would never resume. The cap is
    // applied to the base and the jitter is added after, so a minute is the floor of the capped
    // value, not a hard ceiling.
    const delay = getPartRetryDelay({ status: 503 }, 20);
    expect(delay).toBeGreaterThanOrEqual(60_000);
    expect(delay).toBeLessThan(61_000);
  });

  it('obeys a numeric Retry-After ahead of its own schedule', () => {
    // The server's number is authoritative: retrying sooner than it asked is what turns a 429
    // into a ban.
    expect(getPartRetryDelay({ status: 429, retryAfter: '30' }, 0)).toBe(30_000);
  });

  it('caps a Retry-After the same way', () => {
    expect(getPartRetryDelay({ status: 429, retryAfter: '3600' }, 0)).toBe(60_000);
  });

  it('reads an HTTP-date Retry-After as a delta from now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(getPartRetryDelay({ status: 429, retryAfter: 'Thu, 01 Jan 2026 00:00:20 GMT' }, 0)).toBe(
      20_000
    );
  });

  it('floors a Retry-After date that has already passed, rather than retrying instantly', () => {
    // A skewed client clock can put the server's date in the past; hammering it immediately is
    // the opposite of what the header asked for.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    expect(getPartRetryDelay({ status: 429, retryAfter: 'Thu, 01 Jan 2026 00:00:00 GMT' }, 0)).toBe(
      1000
    );
  });

  it('falls back to the schedule when Retry-After is unparseable', () => {
    const delay = getPartRetryDelay({ status: 429, retryAfter: 'soon' }, 0);
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(2000);
  });
});

/**
 * `describePartFailure` turns the fatal `UploadPartError` into the bounded object that
 * rides in the `/api/upload/abort` body, so the server-side `s3-upload-abort` event can
 * say WHY the client gave up — the field the 2026-09 image-upload investigation found
 * missing ("the abort row carries no reason field"). Tested here rather than only
 * through a client for the same reason as `isTerminalCompleteStatus` above: both upload
 * clients call it, and one of them has no test file of its own.
 */
describe('describePartFailure', () => {
  it('maps nothing to undefined', () => {
    expect(describePartFailure(null)).toBeUndefined();
    expect(describePartFailure(undefined)).toBeUndefined();
  });

  it('maps a user cancel to client-aborted, ahead of every other reading', () => {
    // A cancel trips the workers, which can produce BOTH aborted and (from a racing
    // loadend) a status — the cancel must win, or user churn reads as upload failures.
    expect(describePartFailure({ status: 0, aborted: true })).toEqual({
      kind: 'client-aborted',
    });
  });

  it('maps a network error to network-error with its part number', () => {
    expect(describePartFailure({ status: null, networkError: true, partNumber: 3 })).toEqual({
      kind: 'network-error',
      partNumber: 3,
    });
  });

  it('maps an HTTP status to part-status with its part number', () => {
    expect(describePartFailure({ status: 400, partNumber: 2 })).toEqual({
      kind: 'part-status',
      partNumber: 2,
      status: 400,
    });
  });

  it('omits the part number when the caller had none', () => {
    expect(describePartFailure({ status: null, networkError: true })).toEqual({
      kind: 'network-error',
    });
  });

  it('maps an unlabelled status-less error to undefined rather than inventing a kind', () => {
    expect(describePartFailure({ status: null })).toBeUndefined();
  });
});

/**
 * `shouldRelayOnPartFailure` gates the multipart upload's relay fallback: a client that
 * cannot reach the storage host at the network layer may re-send the whole file through
 * our own origin — the same rescue `useCFImageUpload` got in #4573, extended to the
 * multipart path that `useMediaUpload` (the post-image flow) drives.
 *
 * 🔴 A status failure must NEVER relay: reaching the backend and being rejected is a
 * real fault, and replaying the bytes through a second route would mask it. Only
 * `networkError` — DNS, TLS, connection reset, the ERR_CONNECTION_RESET class the
 * investigation traced — qualifies.
 *
 * 🔴 EVERY FIXTURE BELOW PASSES `userAborted: false`, AND THAT IS ONLY MEANINGFUL BECAUSE
 * THE CALLER CAN NOW PRODUCE IT. The option used to be the caller's abort signal, which
 * the caller's own teardown had always tripped by the time this gate was reached — so this
 * suite was exercising a state production could never reach, and every case in it passed
 * while the feature was inert. What proves the gate is REACHED at all lives at the seam,
 * in `src/hooks/__tests__/useS3Upload.test.ts`; these pin the rules once it is.
 */
describe('shouldRelayOnPartFailure', () => {
  const base = {
    type: 'image',
    backend: 'backblaze',
    fileSize: 5 * 1024 * 1024,
    userAborted: false,
  };

  it('relays a network-layer failure on the image backend', () => {
    expect(shouldRelayOnPartFailure({ status: null, networkError: true }, base)).toBe(true);
  });

  it.each([
    ['', { status: null, networkError: true, aborted: true }],
    ['', { status: 400 }],
    ['', { status: 503 }],
    ['', { status: null }],
  ])('does not relay $1', (_n, err) => {
    expect(shouldRelayOnPartFailure(err as never, base)).toBe(false);
  });

  it('does not relay when the user already cancelled', () => {
    // ⚠ HONEST SCOPE. At the ONE production call site this combination is currently
    // unreachable: the gate is evaluated synchronously right after the worker pool
    // settles, and every path that sets the user flag before the fatal slot is filled
    // ALSO fills that slot with `{ aborted: true, networkError: undefined }` — which the
    // `!err.networkError` clause below refuses first, so neither this clause nor
    // `err.aborted` ever executes there. Both are defence in depth, and this fixture is
    // the only thing that exercises either. Kept because they state the rule, because
    // `useCFImageUpload` may adopt this predicate, and because the multi-worker shape
    // reopens the window — NOT because the production cancel path runs through them.
    expect(
      shouldRelayOnPartFailure({ status: null, networkError: true }, { ...base, userAborted: true })
    ).toBe(false);
  });

  it.each(['model', 'training-images', 'default'] as const)(
    'does not relay for type %s — the relay writes to the image bucket',
    (type) => {
      expect(
        shouldRelayOnPartFailure({ status: null, networkError: true }, { ...base, type })
      ).toBe(false);
    }
  );

  it('does not relay for a backend the relay does not write to', () => {
    expect(
      shouldRelayOnPartFailure({ status: null, networkError: true }, { ...base, backend: 'b2' })
    ).toBe(false);
    expect(
      shouldRelayOnPartFailure(
        { status: null, networkError: true },
        { ...base, backend: undefined }
      )
    ).toBe(false);
  });

  it('relays a file exactly at the relay cap, and nothing above it', () => {
    expect(
      shouldRelayOnPartFailure(
        { status: null, networkError: true },
        {
          ...base,
          fileSize: RELAY_FALLBACK_MAX_BYTES,
        }
      )
    ).toBe(true);
    expect(
      shouldRelayOnPartFailure(
        { status: null, networkError: true },
        {
          ...base,
          fileSize: RELAY_FALLBACK_MAX_BYTES + 1,
        }
      )
    ).toBe(false);
  });

  it('the relay cap matches the route it posts to (10 MB, the Next body-truncation point)', () => {
    expect(RELAY_FALLBACK_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

/**
 * `resolveUploadRowStatus` is the OTHER predicate both upload clients need, and it
 * was open-coded in both until it moved here. It answers one question — did the person
 * stop this upload, or did it fail? — and getting it wrong is user-visible in both
 * directions: a failure reported as a cancel hides a fault from whoever is counting
 * errors, and a cancel reported as a failure puts a red badge on something the user did
 * on purpose.
 */
describe('resolveUploadRowStatus', () => {
  // THREE cases, not more. The seam tests in both clients already assert these outcomes
  // through a real upload; what is pinned here is the one-line rule itself, at the three
  // points that discriminate it — each kills a different mutation of
  // `fatal.aborted || opts.userAborted`, and no fourth case kills anything the first
  // three miss. An enumerated ledger over the return values was written and deleted: the
  // signature is `'aborted' | 'error'`, so a third outcome is a compile error and the
  // assertion could never go red. That is the vacuous-guard shape this whole PR is about.

  it('reports a cancelled part as aborted', () => {
    // Kills dropping `fatal.aborted` — the only case that does, since the other two have
    // the user flag or neither.
    expect(resolveUploadRowStatus({ status: null, aborted: true }, { userAborted: false })).toBe(
      'aborted'
    );
  });

  it('reports a network failure as an error', () => {
    // 🔴 The regression, and the case that kills a predicate hardwired to 'aborted'. Both
    // clients tear their own upload down on a fatal part failure, so a caller that passed
    // its abort signal as `userAborted` made EVERY failed upload report as a cancel.
    expect(
      resolveUploadRowStatus({ status: null, networkError: true }, { userAborted: false })
    ).toBe('error');
  });

  it('reports a cancel that raced a failure onto the fatal slot as aborted', () => {
    // Kills dropping `opts.userAborted`. A non-retryable part failure lands on the fatal
    // slot immediately, so a cancel in the same tick can never overwrite it — without the
    // flag the row blames the upload for something the person did.
    expect(resolveUploadRowStatus({ status: 400, partNumber: 2 }, { userAborted: true })).toBe(
      'aborted'
    );
  });
});
