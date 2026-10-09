import { describe, expect, it } from 'vitest';

import {
  deriveFailureClass,
  parseBuildSignals,
  parseRunId,
} from '~/server/services/blocks/build-signals';

/**
 * The optional structured signals a build callback may carry, and the failure-class table.
 * Every value below is a literal: an expectation derived from the module's own constants
 * would pass whatever the module says.
 */

describe('parseBuildSignals', () => {
  it('absent fields produce no signals and report nothing dropped', () => {
    expect(parseBuildSignals({ slug: 'x', status: 'Failed' })).toEqual({
      signals: {},
      dropped: [],
    });
  });

  it('each valid field round-trips unchanged', () => {
    const body = {
      failedStep: 'scan',
      pipelineStatus: 'Failed',
      failedReason: 'TaskRunTimeout',
      runId: 'app-blocks-my-app-0123abcd-9f8e7d',
    };
    expect(parseBuildSignals(body)).toEqual({ signals: body, dropped: [] });
  });

  it.each(['clone', 'validate', 'build', 'scan', 'push', 'none'])(
    'failedStep %s is accepted',
    (step) => {
      expect(parseBuildSignals({ failedStep: step }).signals.failedStep).toBe(step);
    }
  );

  it.each(['Succeeded', 'Failed', 'Completed', 'None'])(
    'pipelineStatus %s is accepted',
    (status) => {
      expect(parseBuildSignals({ pipelineStatus: status }).signals.pipelineStatus).toBe(status);
    }
  );

  it('boundaries: a 64-letter reason and a 63-char run id are accepted, one more is not', () => {
    const ok = parseBuildSignals({ failedReason: 'R'.repeat(64), runId: 'r'.repeat(63) });
    expect(ok).toEqual({
      signals: { failedReason: 'R'.repeat(64), runId: 'r'.repeat(63) },
      dropped: [],
    });
    const over = parseBuildSignals({ failedReason: 'R'.repeat(65), runId: 'r'.repeat(64) });
    expect(over).toEqual({ signals: {}, dropped: ['failedReason', 'runId'] });
  });

  it.each([
    ['failedStep', 'apply'],
    ['failedStep', 'SCAN'],
    ['pipelineStatus', 'succeeded'],
    ['failedReason', 'Task Run Timeout'],
    ['failedReason', 'TaskRun<script>'],
    ['failedReason', ''],
    ['runId', 'App-Blocks-X'],
    ['runId', 'app_blocks'],
    ['runId', ''],
    ['failedStep', null],
    ['runId', 42],
  ])('an invalid %s (%j) is dropped and reported, and only that field', (field, value) => {
    const { signals, dropped } = parseBuildSignals({
      failedStep: 'build',
      pipelineStatus: 'Failed',
      failedReason: 'Failed',
      runId: 'app-blocks-a-1',
      [field]: value,
    });
    expect(dropped).toEqual([field]);
    expect(field in signals).toBe(false);
    // The valid siblings survive the drop.
    expect(Object.keys(signals).sort()).toEqual(
      ['failedReason', 'failedStep', 'pipelineStatus', 'runId'].filter((f) => f !== field).sort()
    );
  });

  it('parseRunId accepts a run name and rejects anything else', () => {
    expect(parseRunId('app-blocks-review-x-1')).toBe('app-blocks-review-x-1');
    expect(parseRunId('')).toBeUndefined();
    expect(parseRunId(undefined)).toBeUndefined();
    expect(parseRunId('has space')).toBeUndefined();
  });
});

describe('deriveFailureClass — the whole table', () => {
  it.each([
    ['clone', undefined, 'platform'],
    ['clone', 'TaskRunTimeout', 'platform'],
    ['validate', undefined, 'author'],
    ['validate', 'TaskRunTimeout', 'author'],
    ['build', 'TaskRunTimeout', 'transient'],
    ['build', 'Failed', 'unknown'],
    ['build', undefined, 'unknown'],
    ['scan', undefined, 'unknown'],
    ['scan', 'TaskRunTimeout', 'unknown'],
    ['push', undefined, 'transient'],
    ['push', 'Failed', 'transient'],
    ['apply', undefined, 'platform'],
    ['none', undefined, 'unknown'],
  ] as const)('%s + reason %s → %s', (step, reason, expected) => {
    expect(deriveFailureClass(step, reason)).toBe(expected);
  });

  it('never classes a build-step failure as the author’s', () => {
    for (const reason of [undefined, null, 'Failed', 'TaskRunTimeout', 'PodCreationFailed']) {
      expect(deriveFailureClass('build', reason)).not.toBe('author');
    }
  });
});
