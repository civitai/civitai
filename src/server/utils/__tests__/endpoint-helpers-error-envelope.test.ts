import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression coverage for civitai#3845 — the unauthenticated internal-detail
 * DISCLOSURE on the non-`TRPCError` branch of `handleEndpointError`.
 *
 * The incident body served to anonymous callers on `GET /api/v1/apps/{slug}`:
 *
 *   { "message": "An unexpected error occurred",
 *     "error": "\nInvalid `prisma.appCollaborator.findMany()` invocation:\n\n\n
 *               The column `app_collaborators.app_listing_id` does not exist
 *               in the current database." }
 *
 * `handleEndpointError` is the shared 500 chokepoint for 14 REST routes, so the
 * leak is a property of the HELPER, not of that one route — which is why the
 * guard lives here rather than only in the route suite. The route-level
 * counterpart (driving the real handler end to end) is in
 * `src/tests/api/v1/apps/apps-error-envelope.test.ts`.
 *
 * This suite exercises the REAL `handleEndpointError` — `src/__tests__/setup.ts`
 * seeds `TRPC_ORIGINS` precisely so `endpoint-helpers` is importable — and mocks
 * ONLY the logging client, because one of the guards below is about what that
 * client receives.
 */

const { mockLogToAxiom, mockBuildCentralErrorLog, mockWasServerFaultLogged } = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  // Deliberately message-FAITHFUL: the real builder walks the cause chain and
  // carries `.message` through verbatim. Keeping that one field real is what
  // lets the observability guard below detect a future "fix" that stops the
  // leak by redacting the LOG instead of the RESPONSE.
  mockBuildCentralErrorLog: vi.fn((e: unknown) => ({
    name: (e as Error)?.name,
    message: (e as Error)?.message,
  })),
  mockWasServerFaultLogged: vi.fn(() => false),
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
  buildCentralErrorLog: mockBuildCentralErrorLog,
  wasServerFaultLogged: mockWasServerFaultLogged,
}));

import { handleEndpointError } from '~/server/utils/endpoint-helpers';

// The exact internals the incident disclosed. Kept as named constants so the
// assertions below read as "this identifier must not appear", not as a wall of
// string literals.
const LEAKED_TABLE = 'app_collaborators';
const LEAKED_COLUMN = 'app_listing_id';
const LEAKED_MODEL = 'appCollaborator';
const LEAKED_METHOD = 'findMany';

/** Verbatim reproduction of the driver text served in the #3845 incident. */
function driverError() {
  return new Error(
    `\nInvalid \`prisma.${LEAKED_MODEL}.${LEAKED_METHOD}()\` invocation:\n\n\n` +
      `The column \`${LEAKED_TABLE}.${LEAKED_COLUMN}\` does not exist in the current database.`
  );
}

/**
 * Every token that must NOT reach an unauthenticated caller. Asserted against
 * the FULL SERIALIZED BODY rather than a single field, so a leak that merely
 * relocates to another key still fails.
 */
const MUST_NOT_DISCLOSE = [
  LEAKED_TABLE,
  LEAKED_COLUMN,
  LEAKED_MODEL,
  LEAKED_METHOD,
  'prisma.',
  'invocation',
  'does not exist in the current database',
];

function createRes() {
  let statusCode = 200;
  let payload: unknown;
  let headersSent = false;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      headersSent = true;
      return res;
    },
    setHeader() {
      /* noop */
    },
    end() {
      headersSent = true;
      return res;
    },
    get headersSent() {
      return headersSent;
    },
    _status: () => statusCode,
    _json: () => payload,
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWasServerFaultLogged.mockReturnValue(false);
});

describe('handleEndpointError — non-TRPCError branch', () => {
  // ── Guard 1: the disclosure regression (civitai#3845) ──────────────────────
  it('does NOT disclose driver, table or column detail in the 500 response body', () => {
    const res = createRes();

    handleEndpointError(res as never, driverError());

    expect(res._status()).toBe(500);
    const serialized = JSON.stringify(res._json());
    for (const secret of MUST_NOT_DISCLOSE) {
      expect(
        serialized,
        `#3845: the public 500 body must not disclose ${JSON.stringify(
          secret
        )} — full body was ${serialized}`
      ).not.toContain(secret);
    }
  });

  // ── Guard 2: the machine-readable discriminator ────────────────────────────
  it('carries the stable `code` discriminator and string `message`/`error` fields', () => {
    const res = createRes();

    handleEndpointError(res as never, driverError());

    const body = res._json() as Record<string, unknown>;
    expect(body.code, 'the 500 envelope must carry the `code` discriminator').toBe(
      'INTERNAL_SERVER_ERROR'
    );
    // `message` MUST stay a string: the Go CLI's readError decodes it into a
    // `Message string`, and a non-string fails the whole unmarshal.
    expect(typeof body.message, '`message` must remain a string for the CLI decoder').toBe(
      'string'
    );
    // `error` is retained (not deleted) for backwards compatibility — the CLI
    // prefers it over `message` when rendering.
    expect(typeof body.error, '`error` must be retained as a string').toBe('string');
  });

  // ── Guard 3: INVARIANT GUARD (green before the fix, by construction) ───────
  // Not regression coverage: it pins behaviour the fix must PRESERVE. Without
  // it, a future "fix" that stops the leak by deleting the log would pass
  // guards 1-2 while silently destroying 500 attribution.
  it('INVARIANT: still logs the UN-redacted error (observability preserved)', () => {
    const err = driverError();
    const res = createRes();

    handleEndpointError(res as never, err);

    expect(mockBuildCentralErrorLog).toHaveBeenCalledTimes(1);
    // The IDENTICAL error instance — not a copy, not a redacted clone.
    expect(mockBuildCentralErrorLog).toHaveBeenCalledWith(err);

    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    const [payload] = mockLogToAxiom.mock.calls[0] as [Record<string, unknown>];
    expect(payload.source).toBe('handleEndpointError');
    expect(
      String(payload.message),
      'the LOG must keep the un-redacted driver text even though the RESPONSE drops it'
    ).toContain(`${LEAKED_TABLE}.${LEAKED_COLUMN}`);
    expect(String(payload.message)).toContain(`prisma.${LEAKED_MODEL}.${LEAKED_METHOD}()`);
  });

  // ── Guard 4: the un-related branches must be untouched ────────────────────
  it('INVARIANT: a client-abort still short-circuits to 499 with no body', () => {
    const res = createRes();
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });

    handleEndpointError(res as never, abort);

    expect(res._status()).toBe(499);
    expect(res._json()).toBeUndefined();
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('INVARIANT: a fault already logged upstream is not double-logged', () => {
    mockWasServerFaultLogged.mockReturnValue(true);
    const res = createRes();

    handleEndpointError(res as never, driverError());

    expect(res._status()).toBe(500);
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });
});
