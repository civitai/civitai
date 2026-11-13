import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import {
  APP_SUBMIT_FAILURE_REASONS,
  appSubmitFailureFromError,
  appSubmitFailureFromResult,
  classifyAppSubmitFailure,
  clampTelemetryInt,
} from '~/shared/constants/app-telemetry.constants';

/**
 * The submit-failure reason mapping. Every expectation is a LITERAL message as the server
 * produces it, never one built from the classifier's own constants, so a classifier that
 * matched a renamed constant but not the real string would go red here.
 */
describe('classifyAppSubmitFailure', () => {
  it('the ecosystem refusal, exactly as the generation graph throws it, is ecosystem_unavailable', () => {
    // Observed in production as the error a viewer saw after the app loaded.
    expect(
      classifyAppSubmitFailure({
        code: 'BAD_REQUEST',
        message: 'Validation failed: ecosystem: Ecosystem is currently unavailable',
      })
    ).toBe('ecosystem_unavailable');
    // A disabled ecosystem's rule copy is APPENDED to the stable text (`gateRefusalText`).
    expect(
      classifyAppSubmitFailure({
        code: 'BAD_REQUEST',
        message:
          'Validation failed: ecosystem: Ecosystem is currently unavailable. Back after maintenance.',
      })
    ).toBe('ecosystem_unavailable');
    // Also when it is one of several field errors.
    expect(
      classifyAppSubmitFailure({
        code: 'BAD_REQUEST',
        message:
          'Validation failed: prompt: Required, ecosystem: Ecosystem is currently unavailable',
      })
    ).toBe('ecosystem_unavailable');
  });

  it('any other graph validation failure is validation', () => {
    expect(
      classifyAppSubmitFailure({
        code: 'BAD_REQUEST',
        message: 'Validation failed: resources: Invalid input: expected object, received undefined',
      })
    ).toBe('validation');
    // A returned snapshot has no code: the message prefix alone decides it.
    expect(
      classifyAppSubmitFailure({ message: 'Validation failed: input: expected an object' })
    ).toBe('validation');
    // A bare BAD_REQUEST (zod input refusal) is validation too.
    expect(
      classifyAppSubmitFailure({ code: 'BAD_REQUEST', message: '[{"code":"invalid_type"}]' })
    ).toBe('validation');
  });

  it('every spend refusal spelling is insufficient_buzz', () => {
    for (const message of [
      'insufficient buzz budget: estimate 5001 exceeds budget 5000',
      'insufficient buzz budget: workflow price 900 exceeds the limit of 500 Buzz for one multi-step call',
      'Not enough Buzz for this training run.',
      "Hey buddy, seems like you don't have enough funds to perform this action.",
      'Insufficient funds',
    ]) {
      expect(classifyAppSubmitFailure({ code: 'BAD_REQUEST', message }), message).toBe(
        'insufficient_buzz'
      );
      expect(classifyAppSubmitFailure({ message }), `${message} (no code)`).toBe(
        'insufficient_buzz'
      );
    }
  });

  it('a limiter refusal is rate_limited, by code or by message', () => {
    expect(
      classifyAppSubmitFailure({
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded, please retry shortly.',
      })
    ).toBe('rate_limited');
    expect(classifyAppSubmitFailure({ message: 'rate limit exceeded' })).toBe('rate_limited');
  });

  it('server-side faults are server_error', () => {
    for (const code of [
      'INTERNAL_SERVER_ERROR',
      'BAD_GATEWAY',
      'SERVICE_UNAVAILABLE',
      'GATEWAY_TIMEOUT',
      'TIMEOUT',
    ]) {
      expect(classifyAppSubmitFailure({ code, message: 'boom' }), code).toBe('server_error');
    }
  });

  it('anything else is other — and nothing returns a value outside the enum', () => {
    expect(classifyAppSubmitFailure({ code: 'FORBIDDEN', message: 'block lacks scope' })).toBe(
      'other'
    );
    expect(classifyAppSubmitFailure({ code: 'UNAUTHORIZED', message: 'invalid block token' })).toBe(
      'other'
    );
    expect(classifyAppSubmitFailure({})).toBe('other');
    expect(classifyAppSubmitFailure({ code: 42, message: { not: 'a string' } })).toBe('other');
    for (const input of [{ message: 'x'.repeat(10_000) }, { code: 'NOT_A_CODE', message: '' }]) {
      expect(APP_SUBMIT_FAILURE_REASONS).toContain(classifyAppSubmitFailure(input));
    }
  });
});

describe('appSubmitFailureFromError', () => {
  it('reads a server TRPCError code', () => {
    expect(
      appSubmitFailureFromError(new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'slow down' }))
    ).toBe('rate_limited');
  });

  it('reads a client TRPCClientError-shaped `data.code`', () => {
    const clientErr = Object.assign(new Error('upstream died'), {
      data: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect(appSubmitFailureFromError(clientErr)).toBe('server_error');
    const ecosystem = Object.assign(
      new Error('Validation failed: ecosystem: Ecosystem is currently unavailable'),
      { data: { code: 'BAD_REQUEST' } }
    );
    expect(appSubmitFailureFromError(ecosystem)).toBe('ecosystem_unavailable');
  });

  it('is total on non-errors', () => {
    expect(appSubmitFailureFromError(undefined)).toBe('other');
    expect(appSubmitFailureFromError('a string')).toBe('other');
    expect(appSubmitFailureFromError({ data: null })).toBe('other');
  });
});

describe('appSubmitFailureFromResult', () => {
  it('a failed snapshot is a failure, classified by its error', () => {
    expect(
      appSubmitFailureFromResult({
        snapshot: {
          workflowId: 'failed',
          status: 'failed',
          error: 'insufficient buzz budget: estimate 25 exceeds budget 5',
        },
      })
    ).toBe('insufficient_buzz');
  });

  it('a non-failed snapshot, or no snapshot, is not a failure', () => {
    expect(
      appSubmitFailureFromResult({ snapshot: { workflowId: 'wf_1', status: 'unassigned' } })
    ).toBe(null);
    expect(appSubmitFailureFromResult({ submissionUnconfirmed: true })).toBe(null);
    expect(appSubmitFailureFromResult(undefined)).toBe(null);
  });
});

describe('clampTelemetryInt', () => {
  it('floors, clamps to [0, max], and maps junk to 0', () => {
    expect(clampTelemetryInt(12.9, 100)).toBe(12);
    expect(clampTelemetryInt(1e12, 100)).toBe(100);
    expect(clampTelemetryInt(-5, 100)).toBe(0);
    expect(clampTelemetryInt(Number.NaN, 100)).toBe(0);
    expect(clampTelemetryInt(Number.POSITIVE_INFINITY, 100)).toBe(0);
  });
});
