import { Error as DBOSErrors } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import { endedElsewhere, writesFailedEnd } from '../runner';

/**
 * A reply whose workflow threw has its end written by the runner (and its grant forgotten) only
 * when nothing else ends it. A hard cancel or the deadline sweep (usually reaching the catch as a
 * cancel: the reply's `finally` sends to the workflow, and DBOS 5.3's send checks for a cancel
 * first), a conflict (an ownership hand-off with no cancel, as a recovery re-enqueue, or a cancel
 * during `begin`; the executor adopts the recorded outcome, never ERROR) and the recovery limit are
 * ended elsewhere; and a throw once shutdown's drain is over leaves the run PENDING for the next
 * process to recover.
 */
describe('which workflow errors another path ends', () => {
  it('a cancel: Stop’s fallback, or DBOS’s timeout, ends the reply', () => {
    expect(endedElsewhere(new DBOSErrors.DBOSWorkflowCancelledError('run_a'))).toBe(true);
  });

  it('a conflict: the workflow is no longer this execution’s (cancelled, swept or re-enqueued)', () => {
    expect(endedElsewhere(new DBOSErrors.DBOSWorkflowConflictError('run_a'))).toBe(true);
  });

  it('the recovery limit: the first reader of the stream ends the reply', () => {
    expect(endedElsewhere(new DBOSErrors.DBOSMaxRecoveryAttemptsExceededError('run_a', 5))).toBe(
      true
    );
  });

  it('other DBOS errors are the run’s own failure, which nothing else ends', () => {
    for (const error of [
      new DBOSErrors.DBOSQueryTimeoutError(1000),
      new DBOSErrors.DBOSInvalidWorkflowTransitionError('transition'),
      new DBOSErrors.DBOSError('anything else'),
    ])
      expect(endedElsewhere(error), error.name).toBe(false);
  });

  it('and so is the reply’s own error', () => {
    expect(endedElsewhere(new Error('the store went away'))).toBe(false);
    expect(endedElsewhere('not even an error')).toBe(false);
  });
});

describe('when a failed workflow’s end is written', () => {
  it('for the run’s own failure while the process runs (the control)', () => {
    expect(writesFailedEnd(new Error('the store went away'), { drained: false })).toBe(true);
  });

  it('never for a conflict or a cancel', () => {
    for (const error of [
      new DBOSErrors.DBOSWorkflowConflictError('run_a'),
      new DBOSErrors.DBOSWorkflowCancelledError('run_a'),
    ])
      expect(writesFailedEnd(error, { drained: false }), error.name).toBe(false);
  });

  it('never once shutdown’s drain is over: the executor is gone and the run stays PENDING', () => {
    for (const error of [
      new DBOSErrors.DBOSExecutorNotInitializedError(),
      new Error('Cannot use a pool after calling end on the pool'),
    ])
      expect(writesFailedEnd(error, { drained: true }), error.message).toBe(false);
  });

  it('nor for the executor gone, whenever it is seen', () => {
    expect(
      writesFailedEnd(new DBOSErrors.DBOSExecutorNotInitializedError(), { drained: false })
    ).toBe(false);
  });
});
