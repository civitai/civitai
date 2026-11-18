import { describe, expect, it } from 'vitest';
import { REDACTED_BLOCK_TOKEN, redactBlockTokens } from '~/server/logging/redact-block-token';

describe('a search upload URL in a logged input', () => {
  it('is replaced, key kept, like a bearer token', () => {
    expect(
      redactBlockTokens({
        uploadId: 'u',
        uploadUrl: 'https://orchestration.test/v2/consumer/blobs/b',
      })
    ).toEqual({ uploadId: 'u', uploadUrl: REDACTED_BLOCK_TOKEN });
  });
});
