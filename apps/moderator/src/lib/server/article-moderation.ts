import { env } from '$env/dynamic/private';

type ModerateResult = { ok: true } | { ok: false; error: string };

// Run a restore/delete against an article. The cascade (nsfwLevel/ingestion recompute, image + S3
// cleanup, search-index sync) lives in the main app; we POST to its internal callback rather than
// re-port it here (src/pages/api/internal/article-moderation.ts). Unlike the fire-and-forget search
// sync, this is AWAITED and returns a result — the action surfaces success/failure to the moderator.
export async function moderateArticle(input: {
  action: 'restore' | 'delete';
  articleId: number;
  userId: number;
}): Promise<ModerateResult> {
  const base = env.CIVITAI_APP_URL || 'https://civitai.com';
  const token = env.WEBHOOK_TOKEN;
  if (!token) return { ok: false, error: 'WEBHOOK_TOKEN not configured' };

  try {
    const res = await fetch(`${base}/api/internal/article-moderation?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      // Delete fans out to S3 + cache cleanup, so allow well past the search-sync budget.
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Main app returned ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
