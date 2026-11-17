import { describe, expect, it } from 'vitest';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { FEEDBACK_CAPTURE_OWNER_ID as QUEUE_CAPTURE_OWNER_ID } from '@civitai/db-queries/csam-queue';

// The queue package cannot import the shared one, so it keeps its own copy of the capture account.
describe('the capture account the CSAM queue matches', () => {
  it('is the shared capture account', () => {
    expect(QUEUE_CAPTURE_OWNER_ID).toBe(FEEDBACK_CAPTURE_OWNER_ID);
  });
});
