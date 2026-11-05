/**
 * Every decision the PostToolUse pr-review nudge makes. The hook itself is pr-review-nudge.mjs,
 * stdin wiring around this file, split out so a test can import it (as check-writable.logic.mjs).
 *
 * It fires when a Bash call has just opened a civitai/civitai PR (`gh pr create`) or marked one
 * ready (`gh pr ready`), and tells the session to follow the `pr-review` skill: record the PR's
 * intent in HQ before the hosted review's first round finishes, then wait for that round and work
 * its findings. It only adds context; it never blocks a command.
 *
 * The PR number comes from what gh PRINTED, never from the command: `gh pr create` prints the new
 * PR's URL, and `gh pr ready` prints `Pull request civitai/civitai#<n> is marked as "ready for
 * review"` (on stderr). A command that names the PR but did not open or ready it (it failed, or
 * it is quoted in an echo or a commit message) prints neither, so it fires nothing.
 */

const REPO = 'civitai/civitai';

// `gh` at the start of a segment, any flags before `pr` (`gh -R civitai/civitai pr create`), and
// the subcommand right after `pr`.
const GH_PR =
  /(?:^|[;&|\n(]\s*)(?:\w+=\S*\s+)*gh\s+(?:-{1,2}\S+(?:\s+(?!pr\b)[^\s-]\S*)?\s+)*pr\s+(create|ready)\b/;

// The PR as gh prints it. The owner/name must be EXACTLY civitai/civitai: a fork, or another repo
// whose name starts with "civitai", is a different repo.
const CREATED_URL =
  /https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)(?![0-9])/g;
// Only gh's two success lines. Its other lines name the PR too: "is closed. Only draft pull
// requests can be marked …" (it failed) and "is converted to \"draft\"" (`--undo`).
const READY_REF =
  /(?<![A-Za-z0-9._/-])([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*) is (?:marked as|already) "ready for review"/g;

/** The text a Bash tool call printed, whatever shape the runtime gives `tool_response`. */
export function printed(toolResponse) {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  const parts = [toolResponse.stdout, toolResponse.output, toolResponse.stderr].filter(
    (v) => typeof v === 'string'
  );
  return parts.length ? parts.join('\n') : JSON.stringify(toolResponse);
}

function onlyRepoPr(re, text) {
  const prs = new Set();
  for (const m of text.matchAll(re)) {
    if (`${m[1]}/${m[2]}`.toLowerCase() === REPO) prs.add(Number(m[3]));
  }
  // One PR or none: output naming two civitai/civitai PRs is not one we can attribute.
  return prs.size === 1 ? [...prs][0] : null;
}

/**
 * `{ action: 'create' | 'ready', pr: <number>, draft: <bool> }` when the call opened or readied
 * exactly one civitai/civitai PR, else null.
 */
export function prEvent(command, toolResponse) {
  const m = GH_PR.exec(command || '');
  if (!m) return null;
  const action = m[1];
  const out = printed(toolResponse);
  const pr = onlyRepoPr(action === 'create' ? CREATED_URL : READY_REF, out);
  if (pr === null) return null;
  const draft = action === 'create' && /(?:^|\s)(?:--draft|-d)(?=\s|$)/.test(command);
  return { action, pr, draft };
}

/** The context the hook adds for an event from `prEvent`. */
export function nudge({ action, pr, draft }) {
  const ref = `${REPO}#${pr}`;
  const intent =
    `Record its intent in HQ now, before the first round finishes: ` +
    `\`hq pr-review why set ${ref} --intent "<what was asked, and why>"\` ` +
    `(or the HQ MCP tool \`pr_review_why_set\`). The intent is internal: never put it in the PR ` +
    `body or a GitHub comment.`;
  const wait =
    `Then run \`hq pr-review watch ${ref}\` in the background and, when it returns, work the round ` +
    `as the skill says.`;
  if (action === 'create' && draft) {
    return (
      `${ref} was opened as a draft. The hosted review (the \`pr-review\` check) skips drafts, so it ` +
      `starts when the PR is marked ready. Follow the \`pr-review\` skill. ${intent} Run the watch ` +
      `after \`gh pr ready\`.`
    );
  }
  const what = action === 'create' ? 'was opened' : 'was marked ready for review';
  return (
    `${ref} ${what}. The hosted review (the \`pr-review\` check) reviews every new head of it. ` +
    `Follow the \`pr-review\` skill. ${intent} ${wait}`
  );
}
