import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { getChatMembers, getTranscript } from '$lib/server/chat-audit.service';
import { readerOf } from '$lib/server/chat-read-audit';
import { claimThread, getThread, releaseThread, sendAsCivitai } from '$lib/server/message-as-civitai';
import { MESSAGE_AS_CIVITAI_MAX_LENGTH } from '$lib/message-as-civitai';
import { int4Id, parseForm, userIdSchema } from '$lib/server/query';

const threadFail = (message: string) => fail(400, { scope: 'thread' as const, error: message });

export const load: PageServerLoad = async ({ params, locals }) => {
  const parsed = int4Id.safeParse(params.userId);
  if (!parsed.success) error(404, 'Not a user id.');
  const userId = parsed.data;

  const thread = await getThread(userId);
  if (!thread.ok)
    return {
      userId,
      error: thread.error,
      claim: null,
      chatId: null,
      transcript: null,
      members: [],
      me: locals.user.id,
    };

  const { chatId, claim } = thread.value;
  const [transcript, members] = chatId
    ? await Promise.all([getTranscript(readerOf(locals.user), chatId), getChatMembers(chatId)])
    : [null, []];
  return { userId, error: null, claim, chatId, transcript, members, me: locals.user.id };
};

export const actions: Actions = {
  reply: requiresGrant('user.message.asCivitai', async ({ request }) => {
    const input = parseForm(
      userIdSchema.extend({
        message: z.string().trim().min(1).max(MESSAGE_AS_CIVITAI_MAX_LENGTH),
        idempotencyKey: z.string().min(8).max(128),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return threadFail(input);
    const result = await sendAsCivitai(input);
    if (!result.ok) return threadFail(result.error);
    return { success: true, chatId: result.value.chatId, deduped: result.value.deduped };
  }),

  claim: requiresGrant('user.message.asCivitai', async ({ request }) => {
    const input = parseForm(userIdSchema, await request.formData());
    if (typeof input === 'string') return threadFail(input);
    const result = await claimThread(input.userId);
    if (!result.ok) return threadFail(result.error);
    if (!result.value.claimed) return threadFail('Another moderator holds this thread.');
    return { success: true };
  }),

  release: requiresGrant('user.message.asCivitai', async ({ request }) => {
    const input = parseForm(userIdSchema, await request.formData());
    if (typeof input === 'string') return threadFail(input);
    const result = await releaseThread(input.userId);
    if (!result.ok) return threadFail(result.error);
    if (!result.value) return threadFail('You do not hold this thread.');
    return { success: true };
  }),
};
