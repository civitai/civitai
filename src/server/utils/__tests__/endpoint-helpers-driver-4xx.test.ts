import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * civitai#3845 **investigation 3** — driver-authored text reaching the wire at a
 * **4xx**, which the original fix deliberately left alone.
 *
 * `handleEndpointError` genericizes 5xx and passes 4xx through byte-identically,
 * justified in `isRestServerFault` by "4xx is client feedback the caller is meant
 * to read". That holds for a zod issue list or a hand-written "not found". It does
 * NOT hold on the `throwDbError` path: that helper copies the driver's own
 * `message` verbatim, and `prismaErrorToTrpcCode` sends a large slice of Prisma
 * codes to 4xx — so the raw invocation text arrived at 400/404/408/409.
 *
 * The fix keeps the STATUS (a driver error mapped to 404 really is a 404) and
 * replaces only the MESSAGE, logging the un-redacted text on the way out so the
 * suite-wide invariant still holds: text leaves the wire exactly when it enters
 * the log.
 *
 * Mocks ONLY the logging client (spreading the original), because one of the
 * guards below is about what that client receives. `throwDbError`,
 * `handleEndpointError`, `isDriverAuthoredMessage` and the Prisma/pg error classes
 * are all REAL — the defect lives in the seam between them.
 */

const { mockLogToAxiom, mockBuildCentralErrorLog, mockWasServerFaultLogged } = vi.hoisted(() => ({
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  // Message-FAITHFUL on purpose: it is what lets the observability guard detect a
  // future "fix" that stops a leak by redacting the LOG instead of the RESPONSE.
  //
  // `type` is stubbed to the SERVER-fault value ('error') deliberately, which is
  // what the real builder returns for the case that matters — a TIMEOUT/408, the
  // one status `classifyErrorFault` does NOT treat as a client fault. Returning a
  // default of 'info' instead would make the severity assertions below pass
  // whether or not the override exists: the mutant and the fix would be
  // indistinguishable.
  mockBuildCentralErrorLog: vi.fn((e: unknown) => ({
    name: (e as Error)?.name,
    message: (e as Error)?.message,
    type: 'error',
    level: 'error',
  })),
  mockWasServerFaultLogged: vi.fn(() => false),
}));

vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logToAxiom: mockLogToAxiom,
  buildCentralErrorLog: mockBuildCentralErrorLog,
  wasServerFaultLogged: mockWasServerFaultLogged,
}));

import { Prisma } from '@prisma/client';
import { DatabaseError } from 'pg';
import { TRPCError } from '@trpc/server';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { throwBadRequestError, throwDbError } from '~/server/utils/errorHandling';
import { GENERIC_CLIENT_ERROR_BY_STATUS } from '~/server/utils/rest-error-envelope';

const CLIENT_VERSION = '6.13.0';

function createRes() {
  let statusCode = 200;
  let payload: unknown;
  let headersSent = false;
  const headers: Record<string, unknown> = {};
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
    // Records rather than no-ops: the genericized arms must mark the response
    // uncacheable, and a no-op setHeader cannot tell a set header from an unset one.
    setHeader(k: string, v: unknown) {
      headers[k] = v;
      return res;
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
    _header: (k: string) => headers[k],
  };
  return res;
}

/** A real `PrismaClientKnownRequestError`, message shaped like the driver's own. */
function prismaError(code: string, message: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: CLIENT_VERSION,
    meta,
  });
}

/**
 * A real `pg` unique-constraint violation. This is the WORST case in the whole
 * disclosure class and it is not hypothetical: `DatabaseError` carries its fields
 * as ENUMERABLE own properties, and `detail` on a 23505 quotes the offending row
 * VALUE — here a user's email address. Kysely (`~/server/db/kyselyDb`) runs on the
 * `pg` pool, so this class is reachable without Prisma.
 */
const VICTIM_EMAIL = 'victim@example.com';
function pgUniqueViolation() {
  const e = new DatabaseError(
    'duplicate key value violates unique constraint "User_email_key"',
    100,
    'error'
  );
  Object.assign(e, {
    severity: 'ERROR',
    code: '23505',
    detail: `Key (email)=(${VICTIM_EMAIL}) already exists.`,
    schema: 'public',
    table: 'User',
    constraint: 'User_email_key',
  });
  return e;
}

/** Drive the REAL `throwDbError` → REAL `handleEndpointError` seam. */
function throughTheSeam(driver: unknown) {
  const res = createRes();
  try {
    throwDbError(driver);
  } catch (e) {
    handleEndpointError(res as never, e);
  }
  return res;
}

function expectNoneDisclosed(res: ReturnType<typeof createRes>, secrets: string[]) {
  const serialized = JSON.stringify(res._json());
  for (const secret of secrets) {
    expect(
      serialized,
      `#3845/3: a public 4xx body must not disclose ${JSON.stringify(
        secret
      )} — full body was ${serialized}`
    ).not.toContain(secret);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWasServerFaultLogged.mockReturnValue(false);
});

describe('handleEndpointError — driver-authored text at a 4xx (civitai#3845 investigation 3)', () => {
  // ── The four statuses `prismaErrorToTrpcCode` can actually reach ────────────
  // Each case names the real disclosure that shipped at that status.
  it.each([
    {
      label: 'P2000 → 400 discloses the COLUMN',
      code: 'P2000',
      status: 400,
      restCode: 'BAD_REQUEST',
      expected: 'The request could not be processed',
      message:
        "\nInvalid `prisma.appListing.create()` invocation:\n\nThe provided value for the column is too long for the column's type. Column: app_listings.slug",
      secrets: ['app_listings', 'slug', 'appListing', 'prisma.', 'invocation'],
    },
    {
      label: 'P2003 → 409 discloses the FOREIGN KEY CONSTRAINT name',
      code: 'P2003',
      status: 409,
      restCode: 'CONFLICT',
      expected: 'The request conflicts with the current state',
      message:
        '\nInvalid `prisma.appCollaborator.create()` invocation:\n\nForeign key constraint failed on the field: `app_collaborators_app_listing_id_fkey`',
      secrets: ['app_collaborators_app_listing_id_fkey', 'appCollaborator', 'prisma.'],
    },
    {
      label: 'P2025 → 404 discloses the MODEL and METHOD',
      code: 'P2025',
      status: 404,
      restCode: 'NOT_FOUND',
      expected: 'Not found',
      message:
        '\nInvalid `prisma.appListing.delete()` invocation:\n\nAn operation failed because it depends on one or more records that were required but not found.',
      secrets: ['appListing', 'delete()', 'prisma.', 'invocation'],
    },
    {
      label: 'P2024 → 408 discloses the CONNECTION POOL shape',
      code: 'P2024',
      status: 408,
      restCode: 'TIMEOUT',
      expected: 'The request timed out',
      message:
        'Timed out fetching a new connection from the connection pool. (More info: http://pris.ly/d/connection-pool) (Current connection pool timeout: 10, connection limit: 21)',
      secrets: ['connection limit', 'pris.ly', 'connection pool timeout'],
    },
  ])(
    '$label — status kept, message genericized',
    ({ code, status, restCode, message, secrets, expected }) => {
      const res = throughTheSeam(prismaError(code, message));

      expect(res._status(), 'the STATUS must be preserved — this really is a 4xx').toBe(status);
      expectNoneDisclosed(res, secrets);

      const body = res._json() as Record<string, unknown>;
      expect(body.code, 'the envelope discriminator must match the status').toBe(restCode);
      // 🔴 Pinned as a LITERAL, not read back out of
      // `GENERIC_CLIENT_ERROR_BY_STATUS`. Deriving the expectation from the
      // implementation makes the assertion vacuous: an audit mutated 400's message
      // to `''` and this suite stayed green, because both sides moved together.
      // The wire contract is the literal text, so the literal is what a test owes.
      expect(body.message).toBe(expected);
      // `message` MUST stay a string — the Go CLI decodes it into `Message string`
      // and a non-string fails the whole envelope unmarshal.
      expect(typeof body.message).toBe('string');
      // The CLI renders `error` in preference to `message`, so it must be non-empty
      // AND must not be the place the leak relocates to.
      expect(body.error).toBe(expected);
      // Cross-check the table this arm reads from, so a change to it that does NOT
      // reach the wire (a stale/unused entry) is also visible.
      expect(GENERIC_CLIENT_ERROR_BY_STATUS[status]).toEqual({ code: restCode, message: expected });
    }
  );

  // ── The headline severity case: actual ROW DATA, from `pg`, not Prisma ──────
  it('INVARIANT: a real pg 23505 does NOT put the offending row value (an email) on the wire', () => {
    // 🔴 An INVARIANT GUARD, not regression coverage for THIS change: it is green
    // on both sides. `throwDbError`'s generic tail maps a non-Prisma error to a
    // 500, which #3850 already genericizes. It is asserted here anyway because it
    // pins the worst payload in the class against a future 5xx regression, and
    // because it is the exact payload the deleted hand-rolled envelopes would
    // have serialized field-by-field. The pg case that this change actually
    // FIXES is the 409 one below, which was red before it.
    const res = throughTheSeam(pgUniqueViolation());

    expectNoneDisclosed(res, [
      VICTIM_EMAIL,
      'Key (email)',
      'User_email_key',
      'duplicate key value',
      '23505',
      'nbtinsert',
    ]);
  });

  it('a pg 23505 mapped to a 409 by a caller is genericized too — status kept, row value gone', () => {
    // The identity predicate is driver-agnostic: it matches whenever the text on
    // the wire IS the driver's text, whatever wrapped it and at whatever status.
    const driver = pgUniqueViolation();
    const res = createRes();
    handleEndpointError(
      res as never,
      new TRPCError({ code: 'CONFLICT', message: driver.message, cause: driver })
    );

    expect(res._status()).toBe(409);
    expectNoneDisclosed(res, [VICTIM_EMAIL, 'User_email_key', 'duplicate key value']);
    expect((res._json() as Record<string, unknown>).code).toBe('CONFLICT');
  });

  // ── 🔴 The guard that makes IDENTITY-vs-CHAIN observable ────────────────────
  it('does NOT genericize a HAND-AUTHORED 4xx that merely carries a driver `cause`', () => {
    // `throwBadRequestError(msg, dbError)` attaches the driver as `cause` while
    // writing a message FOR the caller. A predicate that asked "is a driver error
    // in the cause chain" would destroy this message and tell the user nothing.
    // The identity predicate keeps it, because the wire text is not the driver's.
    const HUMAN = 'That slug is already taken — pick another';
    const res = createRes();
    try {
      throwBadRequestError(HUMAN, prismaError('P2002', 'raw driver text nobody should read'));
    } catch (e) {
      handleEndpointError(res as never, e);
    }

    expect(res._status()).toBe(400);
    expect(
      res._json(),
      'a message we wrote must survive verbatim — genericizing it redacts nothing and costs the caller real feedback'
    ).toEqual({ message: HUMAN });
  });

  // ── Observability: genericizing must RELOCATE the text, never destroy it ────
  it('logs the UN-REDACTED driver text for every 4xx it genericizes', () => {
    const message =
      "\nInvalid `prisma.appListing.create()` invocation:\n\nColumn: app_listings.slug";
    throughTheSeam(prismaError('P2000', message));

    expect(mockLogToAxiom, 'a genericized 4xx must be logged — else the only copy is destroyed')
      .toHaveBeenCalledTimes(1);
    const logged = mockLogToAxiom.mock.calls[0][0] as { message?: string };
    expect(logged.message, 'the LOG keeps the driver text the RESPONSE dropped').toContain(
      'app_listings.slug'
    );
  });

  it('does NOT log a 4xx it passes through — only genericized ones become faults', () => {
    const res = createRes();
    handleEndpointError(res as never, new TRPCError({ code: 'NOT_FOUND', message: 'No such app' }));

    expect(res._status()).toBe(404);
    expect(res._json()).toEqual({ message: 'No such app' });
    expect(
      mockLogToAxiom,
      'a hand-authored 4xx is client feedback, not a fault — logging it would flood the error stream'
    ).not.toHaveBeenCalled();
  });

  // ── The genericized response must not be edge-cached ───────────────────────
  it.each([
    { label: 'a genericized 4xx', code: 'P2025', status: 404 },
    { label: 'a genericized 5xx', code: 'P2022', status: 500 },
  ])('$label is marked no-store', ({ code, status }) => {
    // 🔴 `PublicEndpoint` sets `Cache-Control: public, s-maxage=300,
    // stale-while-revalidate=150` on EVERY response before the handler runs.
    // That was survivable while every failure was a 5xx (shared caches do not
    // cache 5xx by default); it stops being survivable once an error answers
    // 404, which IS in the default cacheable set. A transient NOT_FOUND would
    // otherwise be pinned at the edge for 300s + 150s SWR — serving "no such
    // thing" for five minutes after the thing exists.
    const res = throughTheSeam(prismaError(code, 'raw driver text'));

    expect(res._status()).toBe(status);
    expect(
      res._header('Cache-Control'),
      'a genericized error response must never be edge-cacheable'
    ).toBe('no-store, max-age=0');
  });

  // ── Log severity: forensics, not an incident ───────────────────────────────
  it('logs a genericized 408 at INFO, not ERROR — pool exhaustion is wave-shaped', () => {
    // 🔴 The only Prisma codes reaching 408 are P1008/P2024 — connection-pool
    // exhaustion. Logging those at error severity would add one error-board line
    // per affected public request during exactly the incident you need signal in.
    // That is the same "fires in high-volume waves" property for which
    // `isRestServerFault` excludes 503 from the error stream.
    // `classifyErrorFault` treats TIMEOUT as a SERVER fault repo-wide (correct in
    // general), so this arm overrides `type`/`level` locally instead.
    throughTheSeam(prismaError('P2024', 'Timed out fetching a new connection'));

    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    const logged = mockLogToAxiom.mock.calls[0][0] as { type?: string; level?: string };
    // `type` is the load-bearing one: Alloy extracts it into Loki detected_level.
    expect(logged.type, 'a genericized 4xx must not land on the error board').toBe('info');
    expect(logged.level).toBe('info');
  });

  it('still logs a genuine 5xx at ERROR severity (the info override is scoped)', () => {
    // Negative control for the override: if it leaked into the 5xx arm it would
    // silently empty the error board of real faults.
    throughTheSeam(prismaError('P2022', 'raw driver text'));

    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    const logged = mockLogToAxiom.mock.calls[0][0] as { type?: string };
    expect(logged.type, 'a real server fault must still be error-severity').not.toBe('info');
  });

  // ── INVARIANT GUARDS: green on both sides, pinning what must NOT change ─────
  it('INVARIANT: a zod-issue-ARRAY 400 still yields the identical parsed array', () => {
    const issues = [{ code: 'too_small', path: ['limit'], message: 'Number must be >= 1' }];
    const res = createRes();
    handleEndpointError(
      res as never,
      new TRPCError({ code: 'BAD_REQUEST', message: JSON.stringify(issues) })
    );

    expect(res._status()).toBe(400);
    expect(res._json()).toStrictEqual(issues);
  });

  it('INVARIANT: a 503 retry hint stays verbatim even when a driver sits in its cause', () => {
    // 503 is excluded from the fault log, so the response is the ONLY copy of its
    // message — genericizing it would destroy an actionable retry hint rather than
    // relocate it. The `status !== 503` guard is what enforces that.
    const HINT = 'Model search is temporarily overloaded — please retry.';
    const res = createRes();
    handleEndpointError(
      res as never,
      new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: HINT,
        cause: prismaError('P2024', 'Timed out fetching a new connection'),
      })
    );

    expect(res._status()).toBe(503);
    expect(res._json()).toEqual({ message: HINT });
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('INVARIANT: a client abort is still 499 with no body, ahead of every other arm', () => {
    const res = createRes();
    handleEndpointError(res as never, new Error('The operation was aborted'));

    expect(res._status()).toBe(499);
    expect(res._json()).toBeUndefined();
  });
});
