import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canSeeAddresses, requiresGrant } from '$lib/server/access';
import { redactAddresses } from '$lib/server/redact-addresses';
import {
  createChat,
  DEFAULT_CHAT_TITLE,
  findSeededChat,
  listPlaybooks,
} from '$lib/server/assistant/store';
import { MAX_INT4, usersByIds } from '$lib/server/users.service';
import { moderatorDbStatus } from '$lib/moderator-db-status';
import { assistantStoreMessage } from './store-status';

export const load: PageServerLoad = async ({ locals }) => {
  const text = canSeeAddresses(locals) ? (t: string) => t : redactAddresses;
  try {
    const playbooks = await listPlaybooks();
    return {
      playbooks: playbooks.map(({ slug, title, summary }) => ({
        slug,
        title,
        summary: text(summary),
      })),
      playbookError: null,
    };
  } catch (e) {
    console.error('[assistant] playbooks unavailable', e);
    return { playbooks: [], playbookError: assistantStoreMessage(moderatorDbStatus(e)) };
  }
};

const id = z.coerce.number().int().positive().max(MAX_INT4);
const startSchema = z.object({
  userId: id.optional().catch(undefined),
  reportId: id.optional().catch(undefined),
  title: z.string().trim().max(120).optional(),
});

export const actions: Actions = {
  /**
   * A new chat, optionally opened on an account or a report: what the Investigate buttons post. The
   * title is the account's name so the chat list reads as a list of cases. Investigating the same
   * account and report again returns to the open chat about them.
   */
  start: requiresGrant('assistant.use', async ({ request, locals }) => {
    const parsed = startSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: 'Invalid chat.' });
    const { userId, reportId, title } = parsed.data;

    const seeded = userId || reportId;
    let name = title || DEFAULT_CHAT_TITLE;
    if (!title && userId) {
      const user = (await usersByIds([userId])).get(userId);
      name = `${reportId ? `Report #${reportId}: ` : ''}${user?.username ?? `account #${userId}`}`;
    }

    let chatId: number;
    try {
      const open = seeded
        ? await findSeededChat(locals.user.id, {
            userId: userId ?? null,
            reportId: reportId ?? null,
          })
        : null;
      chatId =
        open ??
        (await createChat({
          moderatorId: locals.user.id,
          title: name,
          seedUserId: userId ?? null,
          seedReportId: reportId ?? null,
        }));
    } catch (e) {
      console.error('[assistant] could not create a chat', e);
      return fail(503, { error: assistantStoreMessage(moderatorDbStatus(e)) });
    }
    redirect(303, `/assistant/${chatId}`);
  }),
};
