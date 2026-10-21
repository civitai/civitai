import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { HoldChat } from '$lib/csam-holds/hold-chat';
import { requireIdParam, requirePermission } from '$lib/server/api-guard';
import { getChatWindow } from '$lib/server/chat-audit.service';
import { getChatHold } from '$lib/server/csam-holds.queries';

// Loaded for the selected hold only: the list holds up to 200 rows and most are never opened, and the
// queue switches holds without rerunning the page load. The conversation is private direct messages, so
// it is gated like the held text itself: the page and `csam.report.file`.
export const GET: RequestHandler = async ({ params, locals }) => {
  const holdId = requireIdParam(locals, params.holdId, '/csam/text-holds', 'holdId');
  requirePermission(locals, 'csam.report.file');

  const hold = await getChatHold(holdId);
  if (!hold) error(404, 'No chat on this hold.');

  const rows = await getChatWindow(hold.chatId, hold.messageIds);
  const body: HoldChat = {
    chatId: hold.chatId,
    judgedIds: hold.messageIds,
    senderId: hold.senderId,
    messages: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      userId: row.userId,
      username: row.username,
      content: row.content,
      edited: row.editedAt !== null,
      deleted: row.deletedAt !== null,
    })),
  };
  return json(body);
};
