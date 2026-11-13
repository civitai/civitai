import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/signals/wrapper', () => ({ withSignals: vi.fn(async () => undefined) }));

const { deleteChatMessage } = await import('~/server/services/chat.service');

const message = dbMock.dbWrite.chatMessage;
const audit = vi.fn(async () => undefined);
const row = { id: 5, userId: 10, chatId: 3, content: 'hello', deletedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  message.findFirst.mockResolvedValue(row);
});

describe('deleteChatMessage', () => {
  it('soft-deletes, keeping the row, and audits the old content', async () => {
    await expect(
      deleteChatMessage({ messageId: 5, actorId: 99, isModerator: true, audit })
    ).resolves.toEqual({ messageId: 5, chatId: 3 });
    expect(message.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { deletedAt: expect.any(Date) },
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'delete',
        oldValue: 'hello',
        newValue: '',
        actorRole: 'moderator',
        subjectId: 10,
      })
    );
  });

  it("refuses someone else's message to a non-moderator", async () => {
    await expect(
      deleteChatMessage({ messageId: 5, actorId: 99, isModerator: false, audit })
    ).rejects.toThrow();
    expect(message.update).not.toHaveBeenCalled();
  });

  it('leaves an already deleted message alone', async () => {
    message.findFirst.mockResolvedValue({ ...row, deletedAt: new Date() });
    await deleteChatMessage({ messageId: 5, actorId: 10, isModerator: false, audit });
    expect(message.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
