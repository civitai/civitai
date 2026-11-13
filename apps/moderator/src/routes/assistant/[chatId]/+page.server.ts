import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import {
  archiveChat,
  getChat,
  hasRunningTurn,
  listPlaybooks,
  listTurns,
  renameChat,
  tokensTodayByModel,
} from '$lib/server/assistant/store';
import { TURN_DEADLINE_MS } from '$lib/server/assistant/loop';
import { allowanceToday } from '$lib/server/assistant/turn.service';
import { listPrices, resolveModel } from '$lib/server/assistant/openrouter';
import { ASSISTANT_MODELS, estimateSpend } from '$lib/assistant/models';
import { canSeeAddresses } from '$lib/server/access';
import { redactAddresses } from '$lib/server/redact-addresses';

const chatIdParam = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

function parseChatId(raw: string) {
  const id = chatIdParam.safeParse(raw);
  if (!id.success) error(404, 'No such chat.');
  return id.data;
}

export const load: PageServerLoad = async ({ params, locals }) => {
  const chatId = parseChatId(params.chatId);
  const chat = await getChat(chatId, locals.user.id);
  if (!chat) error(404, 'No such chat.');
  // Closes out a turn its process died during, which would otherwise hold the composer disabled.
  await hasRunningTurn(locals.user.id, TURN_DEADLINE_MS * 2);
  const text = canSeeAddresses(locals) ? (t: string) => t : redactAddresses;
  const [turns, playbooks, today, prices, allowance] = await Promise.all([
    listTurns(chatId),
    listPlaybooks(),
    tokensTodayByModel(locals.user.id),
    listPrices(),
    allowanceToday({ id: locals.user.id, roles: locals.user.roles ?? [] }),
  ]);
  return {
    models: ASSISTANT_MODELS.map(({ id, label }) => ({ id, label })),
    // A chat keeps the model it was last asked on, unless that model has left the list.
    model: resolveModel(turns.at(-1)?.model),
    spend: estimateSpend(today, prices),
    chat,
    turns,
    playbooks: playbooks.map(({ slug, title, summary }) => ({
      slug,
      title,
      summary: text(summary),
    })),
    allowance: { spentUsd: allowance.spentUsd, capUsd: allowance.capUsd },
  };
};

const titleSchema = z.object({ title: z.string().trim().min(1).max(120) });

export const actions: Actions = {
  rename: requiresGrant('assistant.use', async ({ request, params, locals }) => {
    const parsed = titleSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: 'A title is 1-120 characters.' });
    const ok = await renameChat(parseChatId(params.chatId), locals.user.id, parsed.data.title);
    return ok ? { success: true } : fail(404, { error: 'No such chat.' });
  }),
  /** Hides the chat from its moderator's list. Its turns stay in the audit. */
  archive: requiresGrant('assistant.use', async ({ params, locals }) => {
    const ok = await archiveChat(parseChatId(params.chatId), locals.user.id);
    if (!ok) return fail(404, { error: 'No such chat.' });
    redirect(303, '/assistant');
  }),
};
