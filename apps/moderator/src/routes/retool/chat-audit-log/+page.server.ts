import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import {
  chatAuditEventTypes,
  getChatAuditEvents,
  type ChatAuditCursor,
} from '$lib/server/chat-audit-log.service';

const PAGE = 50;
const id = z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined);
const CURSOR =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)_(-?\d+)_(\d+)_(-?\d+)_(-?\d+)_(edit|delete|clear|read)$/;
const isInt32 = (n: number) => Number.isSafeInteger(n) && n >= -(2 ** 31) && n < 2 ** 31;

const querySchema = z.object({
  chat: id,
  actor: id,
  type: z.enum(chatAuditEventTypes).optional().catch(undefined),
  before: z
    .string()
    .optional()
    .transform((v): ChatAuditCursor | undefined => {
      const m = v?.match(CURSOR);
      if (!m) return undefined;
      const [chatId, messageId, actorId, subjectId] = m.slice(2, 6).map(Number);
      // A hand-edited cursor out of Int32 range would fail the whole query; drop it instead.
      if (![chatId, messageId, actorId, subjectId].every(isInt32)) return undefined;
      return { at: m[1], chatId, messageId, actorId, subjectId, type: m[6] };
    })
    .catch(undefined),
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
