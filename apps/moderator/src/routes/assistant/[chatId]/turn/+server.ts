import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { admitTurn, BUSY, executeTurn } from '$lib/server/assistant/turn.service';
import { denied } from '$lib/permissions';
import { findModel } from '$lib/assistant/models';
import type { TurnEvent } from '$lib/assistant/types';

const KEEPALIVE_MS = 20_000;

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
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false;
        }
      };
      const emit = (event: TurnEvent) => send(`${JSON.stringify(event)}\n`);
      // A lookup can run silent for over a minute; a blank line (which the client skips) keeps a
      // proxy's idle timeout from cutting the stream while the turn is still working.
      keepalive = setInterval(() => send('\n'), KEEPALIVE_MS);
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
          clearInterval(keepalive);
          if (open) controller.close();
          open = false;
        });
    },
    cancel() {
      clearInterval(keepalive);
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
