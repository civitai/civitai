import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam, requirePermission } from '$lib/server/api-guard';
import { logToAxiom } from '$lib/server/axiom';
import {
  PROMPT_SCAN_DAYS,
  PROMPT_SCAN_LIMITS,
  type PromptScanDays,
  type PromptScanLimit,
} from '$lib/prompt-scans';
import { getPromptScans } from '$lib/server/prompt-scans.service';

const PAGES = ['/retool/user-lookup'];

/** A query value outside the offered set falls back to the first option rather than reaching the query. */
const pick = <T extends number>(raw: string | null, allowed: readonly T[]): T =>
  allowed.find((v) => String(v) === raw) ?? allowed[0];

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireIdParam(locals, params.userId, PAGES, 'userId');
  requirePermission(locals, 'user.generations.view');
  const days: PromptScanDays = pick(url.searchParams.get('days'), PROMPT_SCAN_DAYS);
  const limit: PromptScanLimit = pick(url.searchParams.get('limit'), PROMPT_SCAN_LIMITS);

  try {
    const items = await getPromptScans(userId, { days, limit });
    // Prompt text is evidence of what an account asked for; who read whose is our only record of it.
    void logToAxiom({
      name: 'user-prompt-scans-view',
      type: 'info',
      moderatorId: locals.user.id,
      subjectUserId: userId,
      days,
      limit,
      rows: items.length,
    }).catch(() => null);
    return json({ items, days, limit });
  } catch (e) {
    console.error('[user-prompt-scans] query failed', e);
    // Never 502 or 504: Cloudflare swaps those for its own HTML page.
    return json({ error: 'Could not read the prompt scans.' }, { status: 503 });
  }
};
