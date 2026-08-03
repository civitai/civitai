import { describe, expect, it } from 'vitest';
import {
  classifyScanThrow,
  extractErrorMessage,
  extractTrpcErrorCode,
} from '../blockImageScanLogic';

/**
 * App Blocks (Phase-2b) — the async scan verdict classifier. The blocked-vs-error
 * split is SECURITY-relevant (blocked = terminal moderation refusal, error =
 * retryable transient), so it is a PURE, node-unit-tested decision that reads the
 * tRPC error CODE, never prose. Mirrors a TRPCClientError's observed shape
 * (`.data.code` / `.shape.data.code` + `.message`).
 */

// A minimal stand-in for a TRPCClientError as observed on the client.
function trpcErr(code: string, message = 'server said no') {
  return { name: 'TRPCClientError', message, data: { code, httpStatus: 400 } };
}

describe('extractTrpcErrorCode', () => {
  it('reads .data.code', () => {
    expect(extractTrpcErrorCode(trpcErr('BAD_REQUEST'))).toBe('BAD_REQUEST');
  });

  it('falls back to .shape.data.code', () => {
    expect(extractTrpcErrorCode({ shape: { data: { code: 'NOT_FOUND' } } })).toBe('NOT_FOUND');
  });

  it('returns undefined for a non-tRPC throw (network TypeError, string, null)', () => {
    expect(extractTrpcErrorCode(new TypeError('Failed to fetch'))).toBeUndefined();
    expect(extractTrpcErrorCode('boom')).toBeUndefined();
    expect(extractTrpcErrorCode(null)).toBeUndefined();
    expect(extractTrpcErrorCode({ data: { code: 42 } })).toBeUndefined();
  });
});

describe('extractErrorMessage', () => {
  it('reads a non-empty string .message', () => {
    expect(extractErrorMessage({ message: 'nope' })).toBe('nope');
    expect(extractErrorMessage(new Error('kaboom'))).toBe('kaboom');
  });
  it('returns undefined for a missing / empty / non-string message', () => {
    expect(extractErrorMessage({})).toBeUndefined();
    expect(extractErrorMessage({ message: '' })).toBeUndefined();
    expect(extractErrorMessage({ message: 42 })).toBeUndefined();
    expect(extractErrorMessage(null)).toBeUndefined();
  });
});

describe('classifyScanThrow (blocked = terminal moderation, error = retryable)', () => {
  it('BAD_REQUEST → blocked, carrying the server message as reason', () => {
    expect(classifyScanThrow(trpcErr('BAD_REQUEST', 'that image was rejected during scanning'))).toEqual(
      { status: 'blocked', reason: 'that image was rejected during scanning' }
    );
  });

  it('BAD_REQUEST with no message → blocked without a reason', () => {
    expect(classifyScanThrow({ data: { code: 'BAD_REQUEST' } })).toEqual({ status: 'blocked' });
  });

  it('NOT_FOUND → error (retryable), NOT blocked', () => {
    expect(classifyScanThrow(trpcErr('NOT_FOUND', 'Image not found'))).toEqual({
      status: 'error',
      message: 'Image not found',
    });
  });

  it('FORBIDDEN → error (retryable), NOT blocked', () => {
    const r = classifyScanThrow(trpcErr('FORBIDDEN', 'You do not own this image'));
    expect(r.status).toBe('error');
  });

  it('a network throw (no tRPC code) → error, NEVER mislabelled blocked', () => {
    const r = classifyScanThrow(new TypeError('Failed to fetch'));
    expect(r).toEqual({ status: 'error', message: 'Failed to fetch' });
    expect(r.status).not.toBe('blocked');
  });

  it('an unknown tRPC code → error (only BAD_REQUEST is terminal moderation)', () => {
    expect(classifyScanThrow(trpcErr('INTERNAL_SERVER_ERROR')).status).toBe('error');
    expect(classifyScanThrow(trpcErr('TIMEOUT')).status).toBe('error');
  });
});
