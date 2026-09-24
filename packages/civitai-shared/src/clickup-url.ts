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
