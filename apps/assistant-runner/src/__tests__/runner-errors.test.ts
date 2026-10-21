import { Error as DBOSErrors } from '@dbos-inc/dbos-sdk';
import { describe, expect, it } from 'vitest';

import { endedElsewhere } from '../runner';

/**
 * A reply whose workflow threw is ended by the runner (its head end written, its grant forgotten)
 * unless another path ends it. Only two do: a cancel, and the recovery limit.
 */
describe('which workflow errors another path ends', () => {
  it('a cancel: Stop’s fallback, or DBOS’s timeout, ends the reply', () => {
    expect(endedElsewhere(new DBOSErrors.DBOSWorkflowCancelledError('run_a'))).toBe(true);
  });

  it('the recovery limit: the first reader of the stream ends the reply', () => {
    expect(endedElsewhere(new DBOSErrors.DBOSMaxRecoveryAttemptsExceededError('run_a', 5))).toBe(
      true
    );
  });

  it('any other DBOS error is the run’s own failure, recorded ERROR and never recovered', () => {
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
