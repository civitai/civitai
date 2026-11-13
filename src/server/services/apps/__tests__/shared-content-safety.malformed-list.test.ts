import { vi, describe, it, expect, beforeEach } from 'vitest';

import { BlocklistType } from '~/server/common/enums';
import { isEscalatedServerFault } from '~/server/logging/server-fault-override';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { assertSharedTextSafe, SharedContentBlockedError } from '../shared-content-safety';

void dbMock;

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { USER_CONTENT_PATTERN_ENFORCE: 'user-content-pattern-enforce' },
  getFliptBoolean: async () => false,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(async () => ({ success: true })),
}));

/**
 * Through the REAL blocklist service, only redis stubbed. The cached list key is written by more
 * than one app, so a malformed entry is a realistic state: here a `null` among the patterns
 * passes the pre-read (the read itself succeeds) and then throws inside the scan. That is our
 * fault, not the caller's — but it is reached on every write, so it is charged and LOGGED rather
 * than refunded, and the log is the only place it shows up.
 */
describe('assertSharedTextSafe — a malformed cached list entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.redis.get.mockImplementation(async (key: string) => {
      if (key.endsWith(`:${BlocklistType.LinkDomain}`))
        return JSON.stringify({ type: BlocklistType.LinkDomain, data: [] });
      if (key.endsWith(`:${BlocklistType.MessagePattern}`))
        return JSON.stringify({ type: BlocklistType.MessagePattern, data: ['zzz', null] });
      return null;
    });
  });

  it('is refused, not escalated, and logged once at error severity', async () => {
    const error = await assertSharedTextSafe({
      title: 'A listing',
      body: 'some text',
      userId: 1,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(SharedContentBlockedError);
    expect((error as SharedContentBlockedError).message).toBe(
      'Content could not be reviewed right now. Please try again.'
    );
    expect(isEscalatedServerFault(error)).toBe(false);

    const errorLogs = loggingMock.logToAxiom.mock.calls.filter(
      ([entry]) => (entry as { type?: string })?.type === 'error'
    );
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0][0]).toMatchObject({
      name: 'app-shared-content-scan-failed',
      details: { surface: 'appSharedStorage', errorName: 'TypeError' },
    });
    expect(JSON.stringify(errorLogs[0][0])).not.toContain('some text');
  });
});
