import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { admitTurn, BUSY, executeTurn } from '$lib/server/assistant/turn.service';
import { denied } from '$lib/permissions';
import { findModel } from '$lib/assistant/models';
import type { TurnEvent } from '$lib/assistant/types';

const bodySchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  playbook: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(60)
    .nullish(),
  // Only a listed model: each was checked to route under the no-retention policy.
  model: z
    .string()
    .refine((id) => !!findModel(id))
    .nullish(),
});

/**
 * One question to the assistant, answered as a stream of newline-delimited JSON events (`TurnEvent`):
 * which tool is running, then the answer. A stream rather than a form action because a turn runs for
 * tens of seconds across several lookups, and a silent form for that long reads as a hang.
 *
 * The turn runs to completion and records its audit row even if the moderator closes the tab: the
 * stream only reports on it.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.grants['assistant.use']) error(403, denied('assistant.use'));
  const chatId = Number(params.chatId);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) error(404, 'No such chat.');
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success)
    error(
      400,
      body.error.issues.some((i) => i.path[0] === 'model')
        ? 'That model is not one the assistant can use.'
        : 'Ask a question of up to 4,000 characters.'
    );

  const admitted = await admitTurn(chatId, {
    id: locals.user.id,
    roles: locals.user.roles ?? [],
  });
  if (!admitted.ok) return json({ error: admitted.error }, { status: admitted.status });

  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: TurnEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };
      executeTurn({
        chatId,
        moderator: { id: locals.user.id, username: locals.user.username ?? null },
        prompt: body.data.prompt,
        playbookSlug: body.data.playbook ?? null,
        model: body.data.model ?? null,
        canAccess: (path) => canAccess(locals.user, path),
        hasGrant: (permission) => !!locals.grants[permission],
        allowance: admitted.allowance,
        emit,
      })
        .catch((e) => {
          console.error('[assistant] turn failed', e);
          // 23505: another of this moderator's questions started first (the one-running-turn index).
          const busy = (e as { code?: string } | null)?.code === '23505';
          emit({ type: 'error', error: busy ? BUSY : 'The turn failed.' });
        })
        .finally(() => {
          if (open) controller.close();
          open = false;
        });
    },
    cancel() {
      open = false;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
};
