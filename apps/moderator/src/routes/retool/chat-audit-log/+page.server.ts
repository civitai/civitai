import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import { chatAuditEventTypes, getChatAuditEvents } from '$lib/server/chat-audit-log.service';
import { parseChatAuditCursor } from '$lib/chat-audit-cursor';

const PAGE = 50;
const id = z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined);

const querySchema = z.object({
  chat: id,
  actor: id,
  type: z.enum(chatAuditEventTypes).optional().catch(undefined),
  before: z.string().optional().transform(parseChatAuditCursor).catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const filter = parseQuery(url, querySchema);
  try {
    const { events, next } = await getChatAuditEvents(
      { chatId: filter.chat, actorId: filter.actor, type: filter.type, before: filter.before },
      PAGE
    );
    return { filter, events, next, error: null };
  } catch (e) {
    console.error('[chat-audit-log] log unavailable', e);
    return { filter, events: [], next: null, error: 'The chat audit log could not be read.' };
  }
};
