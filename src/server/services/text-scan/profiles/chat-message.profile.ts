import { dbWrite } from '~/server/db/client';
import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { scamEligibleAuthors, scamSubject } from '~/server/services/text-scan/profiles/scam-text';
import type { TextScanSubject } from '~/server/services/text-scan/types';
import { ChatMessageType } from '~/shared/utils/prisma/enums';

export const CHAT_WINDOW_MAX_MESSAGES = 20;
export const CHAT_WINDOW_MAX_CHARS = 3000;
export const CHAT_WINDOW_LOOKBACK_MS = 86_400_000;
export const CHAT_WINDOW_MIN_CHARS = 20;
export const CHAT_WINDOW_SCAN_ROWS = 500;

async function loadChatWindow(newestId: number): Promise<TextScanSubject | undefined> {
  const newest = await dbWrite.chatMessage.findUnique({
    where: { id: newestId },
    select: {
      id: true,
      chatId: true,
      userId: true,
      createdAt: true,
      editedAt: true,
      contentType: true,
      deletedAt: true,
    },
  });
  if (
    !newest ||
    newest.userId <= 0 ||
    newest.contentType !== ChatMessageType.Markdown ||
    newest.deletedAt
  )
    return undefined;
  if (!(await scamEligibleAuthors([newest.userId])).has(newest.userId)) return undefined;

  // Bounds the backward walk in a busy chat where this sender said little. `deletedAt: null` is what
  // lets the partial (chatId, id) index serve it.
  const floor = await dbWrite.chatMessage.findFirst({
    where: { chatId: newest.chatId, id: { lte: newest.id }, deletedAt: null },
    orderBy: { id: 'desc' },
    skip: CHAT_WINDOW_SCAN_ROWS - 1,
    select: { id: true },
  });

  const rows = await dbWrite.chatMessage.findMany({
    where: {
      chatId: newest.chatId,
      userId: newest.userId,
      id: { lte: newest.id, ...(floor ? { gte: floor.id } : {}) },
      deletedAt: null,
      contentType: ChatMessageType.Markdown,
      createdAt: { gte: new Date(newest.createdAt.getTime() - CHAT_WINDOW_LOOKBACK_MS) },
    },
    orderBy: { id: 'desc' },
    take: CHAT_WINDOW_MAX_MESSAGES,
    select: { id: true, content: true },
  });

  const kept: { id: number; text: string }[] = [];
  let chars = 0;
  for (const row of rows) {
    const text = row.content.trim();
    if (!text) continue;
    if (kept.length && chars + text.length > CHAT_WINDOW_MAX_CHARS) break;
    kept.push({ id: row.id, text: text.slice(0, CHAT_WINDOW_MAX_CHARS) });
    chars += text.length;
  }

  return scamSubject(
    newest.userId,
    // Newest first: `maxInputChars` keeps the start of the composed message and cuts the end.
    [{ heading: 'Messages, newest first', text: kept.map((m) => m.text).join('\n') }],
    {
      chatId: newest.chatId,
      senderId: newest.userId,
      messageIds: kept.map((m) => m.id),
      contentAt: (newest.editedAt ?? newest.createdAt).toISOString(),
    }
  );
}

export async function loadChatWindows(newestIds: number[]) {
  const windows = new Map<number, TextScanSubject>();
  for (const id of newestIds) {
    const subject = await loadChatWindow(id);
    if (subject) windows.set(id, subject);
  }
  return windows;
}

registerTextScanProfile({
  entityType: 'ChatMessage',
  labels: ['scam'],
  minChars: CHAT_WINDOW_MIN_CHARS,
  load: loadChatWindows,
});
