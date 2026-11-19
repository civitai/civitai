import {
  APP_ACTIVITY,
  APP_ACTIVITY_UNAVAILABLE,
  createAppActivityTool,
  formatAppActivity,
  isAppActivity,
  type AppActivity,
  type AppActivitySource,
} from '@civitai/app-assistant';
import type { ChatTool } from '@civitai/components-chat/civitai-chat';

/**
 * The open app's recent activity on the page: what the preview pane's "App activity" strip shows,
 * and what the page's `app_activity` tool reads (on the server runner, the runner reads civitai's
 * internal endpoint instead, with the same read behind it).
 */

/** What the user's app did, as `GET /api/apps/assistant/activity` answers; `null` = not their app. */
export async function fetchAppActivity(
  blockId: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): Promise<AppActivity | null> {
  const response = await fetchImpl(
    `/api/apps/assistant/activity?blockId=${encodeURIComponent(blockId)}`,
    { credentials: 'same-origin', headers: { accept: 'application/json' } }
  );
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (response.status === 404) return null;
  if (response.ok && isAppActivity(body)) return body;
  // A refusal for who the user is (403) says why; anything else is retryable.
  if (response.status === 403 && typeof body?.error === 'string' && body.error)
    throw new Error(body.error);
  throw new Error(APP_ACTIVITY_UNAVAILABLE);
}

/** The page's source: the same endpoint the strip reads, as the signed-in user. */
export function pageActivitySource(fetchImpl?: typeof fetch): AppActivitySource {
  return { read: (app) => fetchAppActivity(app, fetchImpl) };
}

/** `app_activity` for the page, for the app open in it. */
export function createPageActivityTools(
  current: () => string | null,
  source: AppActivitySource = pageActivitySource()
): Record<string, ChatTool> {
  return { [APP_ACTIVITY]: createAppActivityTool({ current, source }) };
}

/** Items the strip's "Tell the assistant" message carries at most: enough to see the pattern. */
export const TELL_ASSISTANT_ITEMS = 15;

/**
 * What "Tell the assistant" puts in the message box for the user to edit and send: a short ask,
 * then the activity in the tool's own words.
 */
export function tellAssistantText(activity: AppActivity, now: number): string {
  return [
    'The preview of my app seems stuck or wrong. Here is what it did recently; please look at this before guessing what is wrong:',
    '',
    formatAppActivity(activity, now, { maxItems: TELL_ASSISTANT_ITEMS }),
  ].join('\n');
}
