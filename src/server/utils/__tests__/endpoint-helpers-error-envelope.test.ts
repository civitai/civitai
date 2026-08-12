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
 * `handleEndpointError` is the shared 500 chokepoint for 14 REST routes (10 on
 * the public `/api/v1` surface), so the leak is a property of the HELPER, not of
 * that one route — which is why the guard lives here rather than only in the
 * route suite. The route-level counterpart (driving the real handler end to end)
 * is in `src/tests/api/v1/apps/apps-error-envelope.test.ts`.
 *
 * 🔴 The helper has TWO 500-producing branches. This first `describe` covers the
 * non-`TRPCError` one; the second covers the `TRPCError` one, which is where a
 * `throwDbError`-wrapped driver error actually lands and which the original fix
 * left leaking.
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

// Spread the ORIGINAL and override only the three exports this suite drives.
// `~/server/logging/client` has 7 exports; replacing it wholesale with a 3-key
// object makes the mock go stale the moment `endpoint-helpers` (or anything it
// pulls in) reaches for a fourth — a failure that surfaces as an unrelated
// "not a function" far from here.
vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logToAxiom: mockLogToAxiom,
  buildCentralErrorLog: mockBuildCentralErrorLog,
  wasServerFaultLogged: mockWasServerFaultLogged,
}));

import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { throwDbError } from '~/server/utils/errorHandling';
import { GENERIC_SERVER_ERROR_MESSAGE } from '~/server/utils/rest-error-envelope';

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

/**
 * The SECOND 500-producing branch of the same helper.
 *
 * `handleEndpointError` has two: the `else` (non-`TRPCError`) branch above, and
 * this one. The original #3845 fix changed only the former, which left the leak
 * fully live — because the dominant way a driver error reaches a REST route is
 * NOT as a bare `Error` but as a `TRPCError` built by `throwDbError`
 * (`errorHandling.ts`), whose Prisma map sends `P2022` — the exact code from the
 * incident — to `INTERNAL_SERVER_ERROR`. That TRPCError carries `error.message`
 * verbatim and this branch served it as `{ message: <driver text> }`.
 *
 * The two things this branch must NOT lose, both pinned below:
 *   - 4xx bodies pass through BYTE-IDENTICALLY (the `JSON.parse` exists because
 *     older zod-validation TRPCErrors JSON-encode an issue ARRAY into `message`,
 *     and the shipped Go CLI renders that shape per-field), and
 *   - 503 keeps its message verbatim — see `isRestServerFault`.
 */
describe('handleEndpointError — TRPCError branch', () => {
  /** Exactly what `throwDbError` builds from the #3845 driver error. */
  function dbTrpcError() {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: driverError().message,
      cause: driverError(),
    });
  }

  // ── Guard 5: the #3845 disclosure, on the OTHER 500 branch ─────────────────
  it('does NOT disclose driver, table or column detail on a 500 TRPCError', () => {
    const res = createRes();

    handleEndpointError(res as never, dbTrpcError());

    expect(res._status()).toBe(500);
    const serialized = JSON.stringify(res._json());
    for (const secret of MUST_NOT_DISCLOSE) {
      expect(
        serialized,
        `#3845 (TRPCError branch): the public 500 body must not disclose ${JSON.stringify(
          secret
        )} — full body was ${serialized}`
      ).not.toContain(secret);
    }
  });

  // ── Guard 6: SEAM — the real throwDbError → handleEndpointError chain ──────
  // Neither component's own suite builds this combined state: `throwDbError` is
  // only ever tested on the code it PRODUCES, and the helper is only ever tested
  // on errors a test fabricated. This drives a genuine
  // `PrismaClientKnownRequestError` (code P2022, the incident's) through the real
  // `throwDbError` and into the real helper.
  it('SEAM: a real P2022 driver error through throwDbError does not reach the wire', () => {
    const res = createRes();
    const prismaError = new Prisma.PrismaClientKnownRequestError(driverError().message, {
      code: 'P2022',
      clientVersion: '6.13.0',
      meta: { column: `${LEAKED_TABLE}.${LEAKED_COLUMN}` },
    });

    let thrown: unknown;
    try {
      throwDbError(prismaError);
    } catch (e) {
      thrown = e;
    }

    // Positive control on the FIXTURE: if throwDbError stopped mapping P2022 to a
    // 500 this test would silently be exercising some other status.
    expect(thrown, 'throwDbError must produce a TRPCError').toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code, 'P2022 must map to INTERNAL_SERVER_ERROR').toBe(
      'INTERNAL_SERVER_ERROR'
    );
    expect(
      (thrown as TRPCError).message,
      'the fixture must actually carry the leaked text, or the guard below is vacuous'
    ).toContain(`${LEAKED_TABLE}.${LEAKED_COLUMN}`);

    handleEndpointError(res as never, thrown);

    expect(res._status()).toBe(500);
    const serialized = JSON.stringify(res._json());
    for (const secret of MUST_NOT_DISCLOSE) {
      expect(
        serialized,
        `#3845 seam: the public 500 body must not disclose ${JSON.stringify(
          secret
        )} — full body was ${serialized}`
      ).not.toContain(secret);
    }
  });

  // ── Guard 7: the envelope, by VALUE not by key presence ───────────────────
  it('serves the shared envelope with the generic text in BOTH `message` and `error`', () => {
    const res = createRes();

    handleEndpointError(res as never, dbTrpcError());

    const body = res._json() as Record<string, unknown>;
    expect(body.code, 'the 500 envelope must carry the `code` discriminator').toBe(
      'INTERNAL_SERVER_ERROR'
    );
    expect(body.message, '`message` must be the generic text').toBe(GENERIC_SERVER_ERROR_MESSAGE);
    // Asserted by VALUE: the shipped CLI renders `error` in PREFERENCE to
    // `message`, so an `error` that were blank (or still the driver text) is the
    // whole ballgame and key-presence would not notice either.
    expect(body.error, '`error` must be the generic text too — the CLI prefers it').toBe(
      GENERIC_SERVER_ERROR_MESSAGE
    );
  });

  // ── Guard 8: observability preserved on THIS branch too ───────────────────
  it('INVARIANT: still logs the UN-redacted TRPCError (observability preserved)', () => {
    const err = dbTrpcError();
    const res = createRes();

    handleEndpointError(res as never, err);

    expect(mockBuildCentralErrorLog).toHaveBeenCalledTimes(1);
    expect(mockBuildCentralErrorLog).toHaveBeenCalledWith(err);
    const [payload] = mockLogToAxiom.mock.calls[0] as [Record<string, unknown>];
    expect(
      String(payload.message),
      'the LOG must keep the un-redacted driver text even though the RESPONSE drops it'
    ).toContain(`${LEAKED_TABLE}.${LEAKED_COLUMN}`);
  });

  // ── Guard 9: the 4xx pass-through, EXECUTED rather than reasoned about ────
  it('INVARIANT: a zod-issue-ARRAY 400 still produces the identical parsed body', () => {
    // The shape older zod-validation TRPCErrors carry: the issue array
    // JSON-encoded into `message`. Field values are pairwise distinct so a body
    // assembled from the wrong part of the payload cannot coincidentally match.
    const issues = [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['slug'],
        message: 'Required',
      },
      {
        code: 'too_big',
        maximum: 64,
        type: 'string',
        inclusive: true,
        path: ['slug'],
        message: 'String must contain at most 64 character(s)',
      },
    ];
    const res = createRes();

    handleEndpointError(
      res as never,
      new TRPCError({ code: 'BAD_REQUEST', message: JSON.stringify(issues) })
    );

    expect(res._status(), 'a 400 must NOT be swept into the server-fault branch').toBe(400);
    // BYTE-IDENTICAL: the parsed array itself, not an object wrapping it, and
    // with no `code`/`message`/`error` envelope grafted on.
    expect(
      res._json(),
      'the 400 body must stay the parsed zod issue array, unchanged'
    ).toStrictEqual(issues);
    expect(mockLogToAxiom, 'a 4xx is client feedback, never a logged fault').not.toHaveBeenCalled();
  });

  it('INVARIANT: a plain-string 4xx still produces the identical `{ message }` body', () => {
    const res = createRes();

    handleEndpointError(res as never, new TRPCError({ code: 'NOT_FOUND', message: 'No article' }));

    expect(res._status()).toBe(404);
    expect(res._json(), 'the fallback 4xx body must stay exactly `{ message }`').toStrictEqual({
      message: 'No article',
    });
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  // ── Guard 10: the deliberate 503 carve-out ────────────────────────────────
  it('503 keeps its retry hint VERBATIM and is still not logged (deliberate)', () => {
    const hint = 'Image search is temporarily overloaded — please retry.';
    const res = createRes();

    handleEndpointError(
      res as never,
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: hint })
    );

    expect(res._status()).toBe(503);
    // 503 is excluded from the fault log, so the response is the ONLY copy of
    // this message — genericizing it would destroy it rather than relocate it.
    expect(res._json(), '503 must pass through unchanged').toStrictEqual({ message: hint });
    expect(mockLogToAxiom, '503 stays out of the error stream').not.toHaveBeenCalled();
  });

  // ── Guard 11: BOTH halves pinned ABSOLUTELY, over every 5xx status ─────────
  // One predicate governs both logging and genericizing, so the property that
  // matters is "the text is dropped from the wire EXACTLY when it is preserved
  // in the log". But pinning only that RELATIONSHIP (`genericized === logged`)
  // is far too weak: NEITHER satisfies a biconditional exactly as well as BOTH.
  // A narrowed `isRestServerFault` — e.g. `status === 500` — makes 501/502/504
  // neither genericized nor logged, which simultaneously RE-OPENS the #3845
  // disclosure on those statuses and silently stops logging those faults, while
  // a biconditional stays green throughout. (Verified: that mutant left this
  // suite at 30/30 before this guard was strengthened.)
  //
  // So each side is pinned to its expected VALUE per status instead. That
  // SUBSUMES the coupling — both equal the same constant, therefore equal each
  // other — and additionally fixes WHICH statuses are server faults, which the
  // biconditional never constrained. 503 is the sole carve-out (see
  // `isRestServerFault`): it alone passes through verbatim and stays out of the
  // error stream. Every other 5xx must be both genericized and logged.
  it('INVARIANT: every 5xx except 503 is BOTH genericized AND logged (each pinned absolutely)', () => {
    const cases = [
      { code: 'INTERNAL_SERVER_ERROR', status: 500 },
      { code: 'NOT_IMPLEMENTED', status: 501 },
      { code: 'BAD_GATEWAY', status: 502 },
      { code: 'SERVICE_UNAVAILABLE', status: 503 },
      { code: 'GATEWAY_TIMEOUT', status: 504 },
    ] as const;

    for (const { code, status } of cases) {
      vi.clearAllMocks();
      mockWasServerFaultLogged.mockReturnValue(false);
      const marker = `distinct-text-for-${status}`;
      const res = createRes();

      handleEndpointError(res as never, new TRPCError({ code, message: marker }));

      expect(res._status(), `${code} must map to ${status}`).toBe(status);
      const serialized = JSON.stringify(res._json());
      const genericized = !serialized.includes(marker);
      const logged = mockLogToAxiom.mock.calls.length > 0;

      // 503 is the ONLY 5xx that is not a server fault.
      const isServerFault = status !== 503;

      expect(
        genericized,
        isServerFault
          ? `${code} (${status}): the message must be DROPPED from the wire — it was served ` +
              `verbatim as ${serialized}, which is the #3845 disclosure re-opened on this status`
          : `${code} (${status}): the retry hint must pass through VERBATIM — genericizing it ` +
              `destroys the only copy, since 503 is deliberately excluded from the error stream`
      ).toBe(isServerFault);

      expect(
        logged,
        isServerFault
          ? `${code} (${status}): the fault must be KEPT in the log — genericizing the response ` +
              `without logging destroys the only copy of the message`
          : `${code} (${status}): 503 must stay OUT of the error stream (high-volume transient ` +
              `upstream waves) — it was logged instead`
      ).toBe(isServerFault);
    }
  });

  // ── Guard 12: the threshold boundaries ────────────────────────────────────
  // Pins BOTH sides of `status >= 500`: a 499 must pass through and a 500 must
  // not, so neither `> 500` nor `>= 400` can survive.
  it('INVARIANT: the server-fault threshold sits exactly at 500', () => {
    const belowRes = createRes();
    handleEndpointError(
      belowRes as never,
      new TRPCError({ code: 'CLIENT_CLOSED_REQUEST', message: 'below-threshold-text' })
    );
    expect(belowRes._status()).toBe(499);
    expect(
      JSON.stringify(belowRes._json()),
      '499 is below the threshold — its message must pass through'
    ).toContain('below-threshold-text');

    vi.clearAllMocks();
    mockWasServerFaultLogged.mockReturnValue(false);

    const atRes = createRes();
    handleEndpointError(
      atRes as never,
      new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'at-threshold-text' })
    );
    expect(atRes._status()).toBe(500);
    expect(
      JSON.stringify(atRes._json()),
      '500 is AT the threshold — its message must be genericized'
    ).not.toContain('at-threshold-text');
  });
});
