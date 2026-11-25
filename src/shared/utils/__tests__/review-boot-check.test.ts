import { describe, expect, it } from 'vitest';
import {
  BOOT_CHECK_APPROVE_REFUSAL,
  BOOT_CHECK_HOLD_CLEAR_REASON,
  BOOT_CHECK_HOLD_LABEL,
  BOOT_CHECK_NOT_RUN_NOTICE,
  bootCheckHoldReason,
  bootCheckNotVerified,
  bootCheckFailed,
  bootCheckFailureError,
  bootCheckUnavailable,
  reviewBootCheckSummary,
} from '~/shared/utils/review-boot-check';
import { BLOCK_READY_TIMEOUT_MS } from '~/shared/constants/block-ready.constants';
import { BLOCK_READY_TIMEOUT_MS as PAGE_HOST_READY_TIMEOUT_MS } from '~/components/AppBlocks/pageBlockHostLogic';

const detail = (bootCheck: unknown) => ({ sha: 'a', bootCheck });

describe('reviewBootCheckSummary', () => {
  it('reads result + mode from a preview row', () => {
    expect(
      reviewBootCheckSummary(
        'preview-failed',
        detail({ result: 'failed', mode: 'enforce', ms: 1, firstError: 'x' })
      )
    ).toEqual({ result: 'failed', mode: 'enforce' });
  });

  it.each([
    ['a production deploy state', 'failed', detail({ result: 'failed', mode: 'enforce' })],
    ['no state', null, detail({ result: 'failed', mode: 'enforce' })],
    ['no bootCheck', 'preview-live', { sha: 'a' }],
    ['an unknown result', 'preview-live', detail({ result: 'maybe', mode: 'enforce' })],
    ['an unknown mode', 'preview-live', detail({ result: 'failed', mode: 'off' })],
    ['a non-object detail', 'preview-live', 'oops'],
  ])('%s → null', (_label, state, d) => {
    expect(reviewBootCheckSummary(state, d)).toBeNull();
  });
});

describe('bootCheckFailed (the approve gate) / bootCheckUnavailable', () => {
  it.each([
    [{ result: 'failed', mode: 'enforce' }, true, false],
    [{ result: 'failed', mode: 'shadow' }, false, false],
    [{ result: 'unavailable', mode: 'enforce' }, false, true],
    [{ result: 'unavailable', mode: 'shadow' }, false, false],
    [{ result: 'passed', mode: 'enforce' }, false, false],
    [null, false, false],
    [undefined, false, false],
  ] as const)('%j → failed=%s unavailable=%s', (summary, failed, unavailable) => {
    expect(bootCheckFailed(summary)).toBe(failed);
    expect(bootCheckUnavailable(summary)).toBe(unavailable);
  });
});

describe('bootCheckFailureError', () => {
  it('names the window and the first error, one full stop', () => {
    expect(bootCheckFailureError('TypeError: boom.')).toBe(
      'Boot check: the app loaded but never sent BLOCK_READY within 10s. First error: TypeError: boom. Fix and resubmit.'
    );
  });
  it('no error reported', () => {
    expect(bootCheckFailureError(null)).toBe(
      'Boot check: the app loaded but never sent BLOCK_READY within 10s. No console error was reported: check that the app completes the SDK handshake when it loads. Fix and resubmit.'
    );
  });
  it('the failed-check notice', () => {
    expect(BOOT_CHECK_APPROVE_REFUSAL).toBe(
      'The boot check found that this build never finishes loading (no BLOCK_READY), and placed a boot-check hold on the app. The hold stays until a build of this app passes the boot check; rebuilding or tearing down the preview does not remove it. To approve before that, override the hold with a written reason.'
    );
  });
  it('the hold reason, with and without a first error, and the clear reason', () => {
    expect(bootCheckHoldReason('TypeError: boom.')).toBe(
      'The app loaded but never sent BLOCK_READY within 10s (first error: TypeError: boom). A build of this app that passes the boot check clears this hold'
    );
    expect(bootCheckHoldReason(null)).toBe(
      'The app loaded but never sent BLOCK_READY within 10s. A build of this app that passes the boot check clears this hold'
    );
    expect(BOOT_CHECK_HOLD_CLEAR_REASON).toBe('A later build of this app passed the boot check.');
    expect(BOOT_CHECK_HOLD_LABEL).toBe('Boot check');
  });
  it('the not-run notice', () => {
    expect(BOOT_CHECK_NOT_RUN_NOTICE).toBe(
      'Boot check not run: this build has not passed the boot check, so nobody has confirmed the app finishes loading. Check that the preview starts before you approve.'
    );
  });
});

describe('bootCheckNotVerified (current flag x recorded result)', () => {
  it.each([
    ['enforce', null, true],
    ['enforce', { result: 'unavailable', mode: 'enforce' }, true],
    ['enforce', { result: 'failed', mode: 'enforce' }, true],
    ['enforce', { result: 'passed', mode: 'shadow' }, true],
    ['enforce', { result: 'passed', mode: 'enforce' }, false],
    ['shadow', null, false],
    ['off', null, false],
  ] as const)('flag %s, recorded %j → %s', (mode, summary, out) => {
    expect(bootCheckNotVerified(mode, summary)).toBe(out);
  });
});

describe('BLOCK_READY_TIMEOUT_MS: one window', () => {
  it('is 10 s, and the page host re-exports the same binding', () => {
    expect(BLOCK_READY_TIMEOUT_MS).toBe(10000);
    expect(PAGE_HOST_READY_TIMEOUT_MS).toBe(BLOCK_READY_TIMEOUT_MS);
  });
});
