import { describe, it, expect } from 'vitest';
import { isClickHouseConnectionError } from '~/server/utils/errorHandling';

// Pure classifier tests for the ClickHouse TRANSIENT-error predicate. This gates
// whether a CH failure on the buzz-reward write / image-feed metric enrichment is
// treated as a transient infra brownout (→ fail-soft / 503) vs. left to surface as
// a 500. The central design constraint: TRANSPORT/transient signals match; QUERY and
// SCHEMA errors (UNKNOWN_TABLE, NULL-insert, syntax) must NOT match (so a real bug /
// deploy break still 500s + alerts — the 2026-06-24 missing-table incident).

describe('isClickHouseConnectionError — TRUE for transient transport/infra failures', () => {
  it('matches a bare "socket hang up" Error (the app-side CH brownout signature)', () => {
    expect(isClickHouseConnectionError(new Error('socket hang up'))).toBe(true);
  });

  it('matches our $query-wrapped transport message', () => {
    // The $query wrapper rethrows as: `ClickHouse query failed: <orig>\nQuery: ...`
    const wrapped = new Error('ClickHouse query failed: socket hang up\nQuery: SELECT 1');
    expect(isClickHouseConnectionError(wrapped)).toBe(true);
  });

  it.each([
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
  ])('matches a raw socket error carrying syscall code %s', (code) => {
    const err = Object.assign(new Error('connection problem'), { code });
    expect(isClickHouseConnectionError(err)).toBe(true);
  });

  it.each([
    ['279', 'ALL_CONNECTION_TRIES_FAILED'],
    ['210', 'NETWORK_ERROR / broken pipe'],
    ['209', 'SOCKET_TIMEOUT'],
    ['202', 'TOO_MANY_SIMULTANEOUS_QUERIES (transient capacity)'],
  ])('matches a ClickHouseError with transient code %s (%s)', (code) => {
    // Mirrors @clickhouse/client ClickHouseError shape: numeric `.code` as a string.
    const err = Object.assign(new Error('DB::NetException: ...'), { code, type: 'X' });
    expect(isClickHouseConnectionError(err)).toBe(true);
  });

  it('matches the $query-wrapped "Code: 279 ... All connection tries failed" message', () => {
    const wrapped = new Error(
      'ClickHouse query failed: Code: 279. DB::NetException: All connection tries failed. (ALL_CONNECTION_TRIES_FAILED)\nQuery: SELECT 1'
    );
    expect(isClickHouseConnectionError(wrapped)).toBe(true);
  });

  it('matches the $query-wrapped "Code: 210 ... Broken pipe" message', () => {
    const wrapped = new Error(
      'ClickHouse query failed: Code: 210. DB::NetException: Broken pipe, while writing to socket. (NETWORK_ERROR)'
    );
    expect(isClickHouseConnectionError(wrapped)).toBe(true);
  });

  it('matches the transient-capacity "Too many simultaneous queries" message', () => {
    expect(
      isClickHouseConnectionError(new Error('Too many simultaneous queries for all users'))
    ).toBe(true);
  });

  it('walks the .cause chain (wrapped TRPCError / undici TypeError)', () => {
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const wrapped = Object.assign(new Error('Image feed failed'), { cause });
    expect(isClickHouseConnectionError(wrapped)).toBe(true);
  });
});

describe('isClickHouseConnectionError — FALSE for query/schema/bug errors (MUST still surface)', () => {
  it('does NOT match Code 60 UNKNOWN_TABLE (the missing-table deploy break)', () => {
    const err = Object.assign(
      new Error("Code: 60. DB::Exception: Table default.buzzEvents does not exist. (UNKNOWN_TABLE)"),
      { code: '60', type: 'UNKNOWN_TABLE' }
    );
    expect(isClickHouseConnectionError(err)).toBe(false);
  });

  it('does NOT match the $query-wrapped UNKNOWN_TABLE message', () => {
    const wrapped = new Error(
      'ClickHouse query failed: Code: 60. DB::Exception: Table default.buzzEvents does not exist. (UNKNOWN_TABLE)\nQuery: SELECT * FROM buzzEvents'
    );
    expect(isClickHouseConnectionError(wrapped)).toBe(false);
  });

  it('does NOT match Code 349 (NULL into a non-Nullable column)', () => {
    const err = Object.assign(
      new Error('Code: 349. DB::Exception: Cannot insert NULL value into a column. (CANNOT_INSERT_NULL_IN_ORDINARY_COLUMN)'),
      { code: '349' }
    );
    expect(isClickHouseConnectionError(err)).toBe(false);
  });

  it('does NOT match a generic CH query error (syntax)', () => {
    const err = Object.assign(new Error('Code: 62. DB::Exception: Syntax error. (SYNTAX_ERROR)'), {
      code: '62',
    });
    expect(isClickHouseConnectionError(err)).toBe(false);
  });

  it('does NOT match a real JS bug (TypeError reading undefined)', () => {
    expect(
      isClickHouseConnectionError(new TypeError("Cannot read properties of undefined (reading 'id')"))
    ).toBe(false);
  });

  it('does NOT match null / undefined / non-error', () => {
    expect(isClickHouseConnectionError(null)).toBe(false);
    expect(isClickHouseConnectionError(undefined)).toBe(false);
    expect(isClickHouseConnectionError('socket hang up')).toBe(false); // bare string, no .message
    expect(isClickHouseConnectionError(42)).toBe(false);
  });
});
