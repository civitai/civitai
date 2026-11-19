import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** The feedback capture account is never banned or muted: acting on it acts on nobody. */

vi.mock('~/server/services/orchestrator/cancel-pending-workflows', () => ({
  cancelPendingWorkflows: vi.fn(async () => undefined),
}));

const { setUserMuted, toggleBan } = await import('~/server/services/user.service');

const CAPTURE = FEEDBACK_CAPTURE_OWNER_ID;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.user.findUnique.mockResolvedValue({ muted: false, bannedAt: null } as never);
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ muted: false, bannedAt: null } as never);
});

describe('the feedback capture account', () => {
  it('is never muted', async () => {
    await expect(setUserMuted({ userId: CAPTURE, muted: true })).rejects.toThrow(
      /feedback page captures/
    );
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
  });

  it('is never banned', async () => {
    await expect(toggleBan({ id: CAPTURE, userId: 1, isModerator: true })).rejects.toThrow(
      /feedback page captures/
    );
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
  });

  it('can still be unbanned', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ bannedAt: new Date(), meta: {} } as never);
    await toggleBan({ id: CAPTURE, userId: 1, isModerator: true }).catch((e: Error) => {
      expect(e.message).not.toMatch(/feedback page captures/);
    });
    expect(dbMock.dbWrite.user.update).toHaveBeenCalled();
  });

  // Control: the same calls on an ordinary account get past the refusal to the account read.
  it('leaves an ordinary account to be muted', async () => {
    await setUserMuted({ userId: 42, muted: true }).catch(() => undefined);
    expect(dbMock.dbWrite.user.update).toHaveBeenCalled();
  });

  it('leaves an ordinary account to be banned', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ bannedAt: null, meta: {} } as never);
    await toggleBan({ id: 42, userId: 1, isModerator: true }).catch(() => undefined);
    expect(dbMock.dbWrite.user.update).toHaveBeenCalled();
  });
});
