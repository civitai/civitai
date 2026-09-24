/**
 * The task id inside a ClickUp task URL, or `null` when there isn't one.
 *
 * `https://app.clickup.com/t/8459928/868kfwm3j` -> `868kfwm3j`. Tolerates `-`/`_`
 * so a ClickUp custom task id (`DEV-1234`) parses rather than silently reading
 * as "no link".
 *
 * 🔴 THIS LIVES IN `@civitai/shared` BECAUSE TWO APPS MUST AGREE ON IT, AND THE COST OF
 * DISAGREEING IS SILENT. The main app's ClickUp webhook finds the board entry to close by
 * `clickupUrl contains <taskId>` and then re-parses each candidate through THIS function,
 * keeping only entries whose parsed id equals the task that completed
 * (`resolveBugsByClickupTaskId`). The moderator app validates the URL a moderator pastes when
 * promoting a report. If the validator accepted a shape the matcher cannot parse, the entry
 * would be stored with a link that looks right on screen and can never be matched — the issue
 * would simply never auto-close, with nothing anywhere reporting a failure.
 *
 * So the two are ONE definition on purpose. Do not re-implement it at either call site.
 */
export const clickupTaskIdFromUrl = (url?: string | null): string | null => {
  if (!url) return null;
  const last = url.split('?')[0].split('#')[0].replace(/\/+$/, '').split('/').pop();
  return last && /^[a-z0-9_-]+$/i.test(last) ? last : null;
};

/** Hosts a ClickUp task link is actually served from. */
const CLICKUP_HOSTS = new Set(['app.clickup.com', 'clickup.com', 'www.clickup.com']);

/**
 * Whether a string is a ClickUp task URL that may be STORED as a new link.
 *
 * 🔴 DELIBERATELY STRICTER THAN THE MATCHER ABOVE, AND THE ASYMMETRY IS THE DESIGN.
 * `clickupTaskIdFromUrl` READS values that already exist — including rows written years ago by
 * other tools — so it must stay permissive or it would stop matching links that currently work.
 * This one GATES what may be written, and an input gate has no such obligation.
 *
 * Without the split, the matcher's permissiveness becomes an input contract by accident: it takes
 * the last path-ish segment of anything, so a bare `868kfwm3j` and `https://example.com/t/868kfwm3j`
 * both "parse". The board's own create form has always required `z.url()`
 * (`createBugInput.clickupUrl`), so accepting those would make a new write path LOOSER than the
 * one it is modelled on — and this is the first path that can write this column from the
 * moderator queue.
 *
 * ⚠️ WHAT THIS CANNOT CHECK, stated so the caller does not over-claim on it: the completion
 * webhook is subscribed to ONE ClickUp list, so a well-formed task URL from any other list stores
 * fine and still never auto-closes. That is a scope fact the app cannot verify without a ClickUp
 * API token, which it does not have. Say it in the copy; do not imply this function covers it.
 */
export const isClickupTaskUrl = (url?: string | null): boolean => {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (!CLICKUP_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  // `/t/<id>` and `/t/<team>/<id>` are the two shapes ClickUp serves; both put the task id last.
  if (!parsed.pathname.split('/').filter(Boolean).includes('t')) return false;
  return clickupTaskIdFromUrl(url) !== null;
};
