import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { HoldChat } from '$lib/csam-holds/hold-chat';
import { requireIdParam, requirePermission } from '$lib/server/api-guard';
import { canAccess } from '$lib/server/access';
import { getChatWindow, getJudgedMessages } from '$lib/server/chat-audit.service';
import { getChatHold } from '$lib/server/csam-holds.queries';

// Per selected hold, since the list holds up to 200 rows. Private direct messages, so gated like the held text: the page and `csam.report.file`.
// The other members' messages are what the Chat Audit page guards, so without that access only the held
// sender's judged messages come back.
export const GET: RequestHandler = async ({ params, locals }) => {
  const holdId = requireIdParam(locals, params.holdId, '/csam/text-holds', 'holdId');
  requirePermission(locals, 'csam.report.file');

  const hold = await getChatHold(holdId);
  if (!hold) error(404, 'No chat on this hold.');

  const fullConversation = canAccess(locals.user, '/retool/chat-audit');
  const { rows, omitted } = fullConversation
    ? await getChatWindow(hold.chatId, hold.messageIds)
    : {
        rows: await getJudgedMessages(hold.chatId, hold.messageIds, hold.senderId),
        omitted: 0,
      };
  const body: HoldChat = {
    chatId: hold.chatId,
    judgedIds: hold.messageIds,
    senderId: hold.senderId,
    omitted,
    fullConversation,
    messages: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      userId: row.userId,
      username: row.username,
      bannedAt: row.bannedAt?.toISOString() ?? null,
      content: row.content,
      editedAt: row.editedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
    })),
  };
  return json(body);
};
