import { describe, expect, it } from 'vitest';
import {
  BOOT_CHECK_APPROVE_REFUSAL,
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
  it('the refusal text', () => {
    expect(BOOT_CHECK_APPROVE_REFUSAL).toBe(
      'Cannot approve: the boot check found that this build never finishes loading (no BLOCK_READY). The developer has to fix it and resubmit. Rebuilding the preview re-runs the check.'
    );
  });
});

describe('BLOCK_READY_TIMEOUT_MS: one window', () => {
  it('is 10 s, and the page host re-exports the same binding', () => {
    expect(BLOCK_READY_TIMEOUT_MS).toBe(10000);
    expect(PAGE_HOST_READY_TIMEOUT_MS).toBe(BLOCK_READY_TIMEOUT_MS);
  });
});
