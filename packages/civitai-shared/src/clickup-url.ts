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

  /**
   * 🔴 POSITIONAL, NOT "CONTAINS A `t` SOMEWHERE". An `includes('t')` test plus "the last segment
   * is id-shaped" guarantees only that the URL parses to SOMETHING — never that it parses to the
   * TASK. `…/t/868kfwm3j/subtasks` satisfies both and yields `subtasks`; `…/9011/v/li/900/t/<id>/x`
   * yields `x`; `…/blog/t/how-to-do-things` passes outright. Each stores, renders as a working
   * link, opens the right page in a browser, and can NEVER be matched by the webhook — the exact
   * silent non-closure this gate exists to prevent, arrived at through the gate itself.
   *
   * The two shapes this gate ACCEPTS are `/t/<id>` and `/t/<team>/<id>`. That is not the same as
   * the set ClickUp serves — a List view's address bar produces
   * `/{team}/v/li/{list}?p={task}` (`.claude/skills/clickup/SKILL.md`), which is a real task URL
   * and is refused here, correctly: the matcher would read the LIST id out of it. Anything outside
   * the accepted pair is refused loudly, which is the better failure — the operator can re-copy the
   * link from the task itself, and the refusal message names the shape to paste.
   */
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments[0] !== 't' || segments.length < 2 || segments.length > 3) return false;
  /**
   * 🔴 THE 3-SEGMENT FORM IS AMBIGUOUS BY SHAPE ALONE, and that ambiguity is the whole bug.
   * `/t/<team>/<id>` (canonical) and `/t/<id>/<subtab>` (a task sub-tab) are both "t plus two
   * segments", and the matcher reads the LAST one — so the sub-tab form yields `subtasks` rather
   * than the task. What separates them is that a ClickUp TEAM id is purely numeric while a task id
   * is not, so requiring digits in the middle admits the canonical form and refuses the sub-tab.
   */
  if (segments.length === 3 && !/^\d+$/.test(segments[1])) return false;

  const taskId = clickupTaskIdFromUrl(url);
  if (!taskId) return false;

  /**
   * 🔴 A HYPHENATED/UNDERSCORED TASK ID IS REFUSED, WHICH COVERS CLICKUP'S DOCUMENTED CUSTOM-ID
   * FORMAT — and the matcher above still tolerates it. Same read/write asymmetry as the rest of
   * this gate: deliveries carry ClickUp's INTERNAL task id, so an entry linked by a custom id
   * (`DEV-1234`) never matches and never auto-closes, and storing one would be silently inert.
   *
   * ⚠️ THE CODE IMPLEMENTS A CHARSET RULE; THE CLASS CLAIM IS WIDER THAN THE RULE. Custom ids are
   * documented as `PREFIX-number`, so the charset test catches the documented shape — but a
   * separator-less custom pattern (`ABC123`) would pass, and I could not confirm whether ClickUp's
   * custom-ID pattern feature permits one. Stated rather than papered over: this refuses the
   * documented format, not provably every custom id.
   *
   * ⚠️ THE NUMERIC-TEAM PREMISE IS NOT APPLIED TO THE 2-SEGMENT BRANCH, DELIBERATELY — and the
   * subject of that sentence is the premise, NOT the charset rule directly above it, which DOES run
   * on every path (`/t/DEV-1234` is refused). Spelled out because a pronoun here read as the
   * charset rule, and a reader who took it that way would conclude a 2-segment custom id is
   * accepted. That premise would also refuse `/t/8459928` — a truncated paste of a team id, stored
   * as a task link
   * that can never match. It is left ACCEPTED because the premise needed to refuse it is "a native
   * task id is never purely numeric", and that is unverified: native ids are 9-char base-36-ish and
   * every one seen here begins `86`, but nothing rules out an all-digit id. Refusing on an
   * unverified premise would block a legitimate link. The inconsistency is the deliberate half.
   *
   * The matcher keeps tolerating `-`/`_` because it READS rows written before this gate existed,
   * and tightening it would stop matching links that work today. Source for the custom-id
   * limitation: ClickUp task `868ktfupv`, the integration's shipping record — it is NOT recorded
   * anywhere in this repo, and its named backstop is `check-known-issues-sync.mjs` in the
   * support-agent repo.
   */
  return /^[a-z0-9]+$/i.test(taskId);
};
