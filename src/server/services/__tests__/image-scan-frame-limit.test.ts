import { describe, expect, it } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { logFrameLimitHit } from '~/server/services/image-scan-frame-limit';

describe('logFrameLimitHit', () => {
  it('never throws on a malformed steps array, and logs nothing for it', () => {
    expect(() => logFrameLimitHit({ steps: [null], imageId: 7, workflowId: 'wf' })).not.toThrow();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });
});
