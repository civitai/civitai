import { describe, it, expect } from 'vitest';
import { isClientAbortError } from '~/server/utils/errorHandling';
import { FETCH_DOCUMENTS_TIMEOUT_MESSAGE } from '~/server/meilisearch/client';

describe('isClientAbortError', () => {
  it('classifies a bare client AbortError (REST/Meili fetch path)', () => {
    // undici shape on client disconnect: name=AbortError, the standard message
    expect(isClientAbortError({ name: 'AbortError', message: 'This operation was aborted' })).toBe(
      true
    );
  });

  it('classifies the real prod tRPC shape (message at depth 0, name=TRPCError)', () => {
    // Verified in prod Loki (12.9k/24h): tRPC copies cause.message onto the
    // wrapper, so the NAME is TRPCError — the message check is load-bearing here.
    expect(
      isClientAbortError({ name: 'TRPCError', message: 'This operation was aborted' })
    ).toBe(true);
  });

  it('classifies a tRPC-wrapped abort via the .cause chain', () => {
    expect(
      isClientAbortError({
        name: 'TRPCError',
        code: 'INTERNAL_SERVER_ERROR',
        cause: { name: 'AbortError', message: 'This operation was aborted' },
      })
    ).toBe(true);
  });

  it('matches the alternate Node phrasing "The operation was aborted"', () => {
    expect(isClientAbortError({ name: 'Error', message: 'The operation was aborted' })).toBe(true);
  });

  // ---- must NOT over-classify (these stay 5xx/408, never 499) ----

  it('DRIFT GUARD: does NOT classify our local Meili-deadline abort as a client abort', () => {
    // The local fetchDocumentsAbortable timer aborts with FETCH_DOCUMENTS_TIMEOUT_MESSAGE;
    // if it surfaces as an AbortError-with-cause, the exclusion must still hold. This
    // case fails if the duplicated literal in errorHandling.ts ever drifts from the
    // exported constant — the whole reason the literal exists (circular-import avoidance).
    expect(
      isClientAbortError({
        name: 'AbortError',
        message: 'This operation was aborted',
        cause: { message: FETCH_DOCUMENTS_TIMEOUT_MESSAGE },
      })
    ).toBe(false);
    // and the plain-Error form of the same sentinel
    expect(isClientAbortError({ name: 'Error', message: FETCH_DOCUMENTS_TIMEOUT_MESSAGE })).toBe(
      false
    );
  });

  it('does NOT classify an AbortSignal.timeout() TimeoutError as a client abort', () => {
    // Server-side deadline: name=TimeoutError, message has a " due to timeout" suffix
    // so the exact === checks fail. Must remain a server error.
    expect(
      isClientAbortError({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' })
    ).toBe(false);
  });

  it('does NOT classify genuine server errors as client aborts', () => {
    expect(isClientAbortError({ name: 'MeiliSearchCommunicationError', message: 'fetch failed' })).toBe(
      false
    );
    expect(isClientAbortError({ name: 'Error', message: 'boom' })).toBe(false);
    expect(isClientAbortError({ name: 'TRPCError', code: 'NOT_FOUND', message: 'No image' })).toBe(
      false
    );
    expect(isClientAbortError(null)).toBe(false);
    expect(isClientAbortError(undefined)).toBe(false);
  });
});
