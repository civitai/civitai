import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'active'),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(async () => ({
    base: { id: 1, key: 'base', content: 'BASE PROMPT' },
    'label:scam': { id: 2, key: 'label:scam', content: 'SCAM DEF' },
  })),
  getTextScanConfig: vi.fn(async () => ({
    model: 'air:test',
    maxInputChars: 1000,
    thinking: false,
  })),
}));

await import('~/server/services/text-scan/profiles/chat-message.profile');
const { scanEntity } = await import('~/server/services/text-scan/submit');
const { submitWorkflow } = await import('@civitai/client');
const { CHAT_WINDOW_MIN_CHARS } = await import(
  '~/server/services/text-scan/profiles/chat-message.profile'
);

const window = (content: string) => {
  dbMock.dbWrite.chatMessage.findUnique.mockResolvedValue({
    id: 30,
    chatId: 4,
    userId: 5,
    createdAt: new Date(),
    editedAt: null,
    contentType: 'Markdown',
    deletedAt: null,
  });
  dbMock.dbWrite.chatMessage.findMany.mockResolvedValue([{ id: 30, content }]);
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.user.findMany.mockResolvedValue([{ id: 5, isModerator: false }]);
  vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-1' } } as never);
});

describe('chat window minChars', () => {
  it('skips a window shorter than the threshold in raw characters, heading excluded', async () => {
    window('hi there');
    expect(await scanEntity({ entityType: 'ChatMessage', entityId: 30 })).toEqual({
      status: 'skipped',
      reason: 'too-short',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('submits a window at the threshold', async () => {
    window('x'.repeat(CHAT_WINDOW_MIN_CHARS));
    expect(await scanEntity({ entityType: 'ChatMessage', entityId: 30 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });
});
