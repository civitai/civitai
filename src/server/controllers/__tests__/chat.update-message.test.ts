import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as ChatService from '~/server/services/chat.service';
import type * as ScamScanQueue from '~/server/services/text-scan/scam-scan-queue';

const { editChatMessageContent, queueScamScan } = vi.hoisted(() => ({
  editChatMessageContent: vi.fn(),
  queueScamScan: vi.fn(),
}));

vi.mock('~/server/services/chat.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatService>()),
  editChatMessageContent,
}));
vi.mock('~/server/services/text-scan/scam-scan-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof ScamScanQueue>()),
  queueScamScan,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedLinkDomain: async () => undefined,
  throwOnBlockedMessagePattern: async () => undefined,
}));

const { updateMessageHandler } = await import('../chat.controller');

const SENDER = 5;
const chatAudit = vi.fn(async () => undefined);
const ctx = () =>
  ({
    user: { id: SENDER, isModerator: false, muted: false, bannedAt: null },
    features: { chatRedesign: true },
    track: { chatAudit },
  } as never);
const edit = () =>
  updateMessageHandler({ input: { messageId: 1, content: 'new' } as never, ctx: ctx() });

describe('updateMessageHandler', () => {
  beforeEach(() => {
    chatAudit.mockClear();
    queueScamScan.mockClear();
    editChatMessageContent.mockReset();
    dbMock.dbWrite.chatMessage.findFirst.mockResolvedValue({
      id: 1,
      chatId: 3,
      userId: SENDER,
      // What a read before the lock would see, if the handler ever selected it again.
      content: 'stale read',
      deletedAt: null,
    } as never);
  });

  it('logs the text the locked write replaced, not an earlier read of it', async () => {
    editChatMessageContent.mockResolvedValue('what it said when the edit landed');
    await edit();

    expect(chatAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'edit',
        oldValue: 'what it said when the edit landed',
        newValue: 'new',
      })
    );
  });

  it('refuses an edit to a message deleted under it, and records and scans nothing', async () => {
    editChatMessageContent.mockResolvedValue(null);

    await expect(edit()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(chatAudit).not.toHaveBeenCalled();
    expect(queueScamScan).not.toHaveBeenCalled();
  });
});
