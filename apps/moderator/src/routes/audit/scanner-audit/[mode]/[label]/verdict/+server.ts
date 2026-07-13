import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { upsertLabelVerdict } from '$lib/server/scanner-review.service';
import { ReviewVerdict } from '$lib/scanner-audit';

const VALID_VERDICTS = new Set<string>(Object.values(ReviewVerdict));

export const POST: RequestHandler = async ({ request, locals }) => {
  const body = await request.json();
  const { contentHash, version, label, verdict, scanner, content } = body ?? {};

  if (!contentHash || !version || !label || !VALID_VERDICTS.has(verdict))
    error(400, 'Invalid verdict payload');

  await upsertLabelVerdict({
    contentHash,
    version,
    label,
    verdict,
    userId: locals.user.id,
    // Snapshot the resolved content so it survives the orchestrator's TTL.
    contentSnapshot: content ? { scanner, body: content } : undefined,
  });

  return json({ ok: true });
};
