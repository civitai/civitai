import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DatabaseError } from 'pg';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { throwDbError } from '~/server/utils/errorHandling';
import { reconstructApiRoute } from '~/server/prom/http-errors';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * A `res` carrying the request, the way Next's API layer builds it: Node's
 * `ServerResponse` exposes `.req`, and Next populates `query` on that same object.
 * `req` is omitted entirely when `url`/`query` are not supplied, so the
 * no-request case is expressible rather than faked.
 */
function createRes(req?: { url?: string; method?: string; query?: Record<string, unknown> }) {
  const res: Record<string, unknown> = {
    status() {
      return res;
    },
    json() {
      return res;
    },
    setHeader() {
      return res;
    },
    getHeader() {
      return undefined;
    },
    end() {
      return res;
    },
    headersSent: false,
  };
  if (req) res.req = { method: 'GET', ...req };
  return res;
}

/** The logged payload of the single `logToAxiom` call. */
function loggedPayload() {
  expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
  return loggingMock.logToAxiom.mock.calls[0][0] as Record<string, unknown>;
}

/**
 * The REAL production shape behind the 22003 lines: a `pg` DatabaseError, not a
 * synthetic `new Error('out of range')`. `DatabaseError` carries its fields as
 * enumerable own properties, and `22003` is not a Prisma `P####` code, so
 * `throwDbError` maps it to INTERNAL_SERVER_ERROR → 500, which is what production
 * served.
 */
function pgNumericOutOfRange(extra?: Record<string, unknown>) {
  const e = new DatabaseError(
    'value "1790581545842" is out of range for type integer',
    100,
    'error'
  );
  Object.assign(e, { severity: 'ERROR', code: '22003' }, extra ?? {});
  return e;
}

/**
 * A `route` property planted on the error object.
 *
 * ⚠️ It does NOT reach the log, and that is the finding rather than a limitation:
 * `safeError` returns a FIXED key set (name/message/stack/code/causeMessage/inner*) and
 * lifts nothing else, so no error can smuggle a `route` into the merged payload. This
 * fixture exists to make the merge-order assertion below unambiguous — the route on the
 * line is the one the HELPER derived, and cannot have come from the error.
 *
 * A guard for "an existing `route` survives when none is derivable" was written and then
 * DELETED: with a fixed key set that state is unreachable, and a test for an unreachable
 * state passes for the wrong reason forever.
 */
const STRAY = 'STRAY-route-from-the-error-object';

/** Drive the REAL throwDbError → REAL handleEndpointError seam. */
function throughTheSeam(driver: unknown, res: ReturnType<typeof createRes>) {
  try {
    throwDbError(driver);
  } catch (e) {
    handleEndpointError(res as never, e);
  }
}

beforeEach(() => {
  // Clears CALL COUNTS without dropping implementations. The shared `logToAxiom` spy
  // outlives this file under `isolate: false`, so per-file reset is mandatory — an
  // accumulated count is the documented `expected "X" to be called 2 times` class.
  // `wasServerFaultLogged` is the REAL implementation and needs no arranging: none of
  // these fixtures has been through `buildServerFaultErrorLog`, so it returns false.
  vi.clearAllMocks();
});

describe('handleEndpointError route attribution', () => {
  it('names the route on the 500 that the production 22003 lines came from', () => {
    // The exact failing request reproduced against production on 2026-09-29:
    // GET /api/v1/images?limit=1&cursor=-5 → 500 INTERNAL_SERVER_ERROR.
    const res = createRes({
      url: '/api/v1/images?limit=1&cursor=-5',
      query: { limit: '1', cursor: '-5' },
    });
    throughTheSeam(pgNumericOutOfRange(), res);

    const payload = loggedPayload();
    // Literal, NOT derived from the implementation under test.
    expect(payload.route).toBe('GET /api/v1/images');
    expect(payload.source).toBe('handleEndpointError');
    // The message must still be preserved in the log — this change adds a field, it
    // does not trade the un-redacted text away for it.
    expect(payload.message).toContain('out of range for type integer');
  });

  it('logs the HELPER-derived route, never one carried on the error object', () => {
    // The error itself carries `route: STRAY`. The logged route must be the one derived
    // from the request, and STRAY must appear nowhere — which also re-proves the
    // fixed-key-set finding recorded on STRAY above.
    const res = createRes({ url: '/api/v1/images', query: {} });
    throughTheSeam(pgNumericOutOfRange({ route: STRAY }), res);
    const payload = loggedPayload();
    expect(payload.route).toBe('GET /api/v1/images');
    expect(JSON.stringify(payload)).not.toContain(STRAY);
  });

  it('normalizes a dynamic segment instead of logging the raw id', () => {
    // `id` is a ROUTE param (absent from the query string); `token` is a
    // query-string key. Distinct values so neither can stand in for the other.
    const res = createRes({
      url: '/api/v1/model-versions/128713?token=shhh-do-not-log-me',
      query: { id: '128713', token: 'shhh-do-not-log-me' },
    });
    throughTheSeam(pgNumericOutOfRange(), res);
    expect(loggedPayload().route).toBe('GET /api/v1/model-versions/[id]');
  });

  it('[invariant] never logs the query string, so a token passed as a query param cannot leak', () => {
    const SECRET = 'tok_live_4f9c2a77e1b04d3e';
    const res = createRes({
      url: `/api/v1/images?limit=1&token=${SECRET}`,
      query: { limit: '1', token: SECRET },
    });
    throughTheSeam(pgNumericOutOfRange(), res);
    // Assert over the WHOLE payload, not just `route` — a future change that logged
    // `req.url` alongside the route would pass a `route`-only assertion.
    expect(JSON.stringify(loggedPayload())).not.toContain(SECRET);
  });

  it('[invariant] still logs, without throwing, when the response carries no request', () => {
    // A hand-built `res` in a unit test, and the contract that telemetry can never
    // break an error response.
    const res = createRes();
    expect(() => throughTheSeam(pgNumericOutOfRange(), res)).not.toThrow();
    expect(loggedPayload().source).toBe('handleEndpointError');
  });

  it('logs the SAME string the per-route metric labels with', () => {
    // 🔴 The joinability claim, and the reason `reconstructApiRoute` is shared rather
    // than reimplemented: a route seen in civitai_app_http_errors_total{kind="api"}
    // must match its log lines by equality. Both sides are pinned to the same
    // LITERAL, so this is not the vacuous `impl === impl` comparison.
    const req = { method: 'GET', url: '/api/v1/images?limit=1', query: { limit: '1' } };
    const res = createRes(req);
    throughTheSeam(pgNumericOutOfRange(), res);

    const EXPECTED = 'GET /api/v1/images';
    expect(reconstructApiRoute(req as never)).toBe(EXPECTED);
    expect(loggedPayload().route).toBe(EXPECTED);
  });
});
