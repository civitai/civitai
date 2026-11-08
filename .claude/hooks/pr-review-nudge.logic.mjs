/**
 * Every decision the PostToolUse pr-review nudge makes. The hook itself is pr-review-nudge.mjs,
 * stdin wiring around this file, split out so a test can import it (as check-writable.logic.mjs).
 *
 * It fires when a tool call has just opened a civitai/civitai PR or marked one ready, and tells the
 * session to follow the `pr-review` skill: record the PR's intent in HQ before the hosted review's
 * first round finishes, then wait for that round and work its findings. It only adds context; it
 * never blocks a call.
 *
 * The PR's head must be in civitai/civitai, not a fork (`prHeadRepo`), because gh prints the base
 * repo's URL for a fork's PR too, so the URL cannot say. The PR number comes from what the tool
 * returned, never from what it was asked. Any check that fails or cannot run means no nudge,
 * silently.
 */

import { spawnSync } from 'child_process';

const REPO = 'civitai/civitai';
const GH_TIMEOUT_MS = 10_000;

/**
 * The command split as a shell would split it, as an array of segments, each an array of words:
 * quotes ('…', "…" with backslash escapes) keep a word whole, and an unquoted `; & | ( )` or newline
 * ends a segment. One pass over the characters with no backtracking, so its cost is linear in the
 * command's length; it runs on every Bash call. Not a full shell parser: expansions, `$(…)` and
 * heredocs are read as plain words.
 */
export function shellSegments(command) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = '';
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const text = command || '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
    } else if (';&|()\n'.includes(c)) {
      endSegment();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

/**
 * `{ sub: 'create' | 'ready', args: <the words after it> }` when a segment of the command runs
 * `gh … pr create|ready`, else null. A segment may start with `VAR=value` assignments, then `gh`,
 * then flags (a flag without `=` may take one value, as in `-R civitai/civitai`), then `pr` and the
 * subcommand. A segment that does not START with gh (an echo, a commit message, `[ -d x ]`) is not
 * running it.
 */
export function ghPrMatch(command) {
  for (const words of shellSegments(command)) {
    let i = 0;
    while (i < words.length && /^\w+=/.test(words[i])) i++;
    if (words[i] !== 'gh') continue;
    let valueAllowed = false;
    for (i += 1; i < words.length; i++) {
      const word = words[i];
      if (word === 'pr') {
        const sub = words[i + 1];
        if (sub === 'create' || sub === 'ready') return { sub, args: words.slice(i + 2) };
        break;
      }
      if (word.startsWith('-')) {
        valueAllowed = !word.includes('=');
      } else if (valueAllowed) {
        valueAllowed = false;
      } else {
        break;
      }
    }
  }
  return null;
}

/**
 * Whether the create's own words ask for a draft (`-d`, `--draft`, `--draft=true`). Read from the
 * matched segment only, as whole words: gh prints its "Creating draft pull request" line only to a
 * terminal, so a tool call's output cannot say.
 */
function asksForDraft(args) {
  return args.some((w) => w === '-d' || w === '--draft' || w === '--draft=true');
}

// A GitHub PR URL, shared by the gh matcher (CREATED_URL) and the MCP one (PR_URL). It captures any
// owner/name; both callers then require EXACTLY civitai/civitai, since a fork, or another repo whose
// name starts with "civitai", is a different repo.
const PR_URL_SOURCE = String.raw`https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)`;
const CREATED_URL = new RegExp(`${PR_URL_SOURCE}(?![0-9])`, 'g');
// Only gh's success line. Its other lines name the PR too: "is already \"ready for review\"" (nothing
// changed), "is closed. Only draft pull requests can be marked …" (it failed) and "is converted to
// \"draft\"" (`--undo`).
const READY_REF =
  /(?<![A-Za-z0-9._/-])([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*) is marked as "ready for review"/g;
// gh's refusal when the branch already has an open PR (pkg/cmd/pr/create/create.go); it prints that
// PR's URL after it.
const ALREADY_EXISTS = /a pull request for branch "[^"\n]*" into branch "[^"\n]*" already exists:/;

/**
 * The text a Bash tool call printed, whatever shape the runtime gives `tool_response`: every string
 * in it, at any depth (`stdout`, `stderr`, a `content` array of text parts…), one per line. Never a
 * JSON encoding of it, which would escape the quotes gh's ready line is matched by.
 */
export function printed(toolResponse, depth = 0) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (toolResponse == null || typeof toolResponse !== 'object' || depth > 8) return '';
  return Object.values(toolResponse)
    .map((v) => printed(v, depth + 1))
    .filter(Boolean)
    .join('\n');
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
  const match = ghPrMatch(command);
  if (!match) return null;
  const action = match.sub;
  const out = printed(toolResponse);
  if (action === 'create' && ALREADY_EXISTS.test(out)) return null;
  const pr = onlyRepoPr(action === 'create' ? CREATED_URL : READY_REF, out);
  if (pr === null) return null;
  const draft = action === 'create' && asksForDraft(match.args);
  return { action, pr, draft };
}

/** The PR's head repo (`owner/name`) as GitHub reports it, or null when it cannot be read. */
export function prHeadRepo(pr, env = process.env, run = spawnSync) {
  const r = run('gh', ['api', `repos/${REPO}/pulls/${pr}`, '--jq', '.head.repo.full_name'], {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    env,
  });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

// The GitHub MCP server's PR tools, under whatever name the session gave the server.
export const GITHUB_MCP_PR_TOOL = /^mcp__.*github.*__(create_pull_request|update_pull_request)$/i;
const PR_URL = new RegExp(`^${PR_URL_SOURCE}$`);

/**
 * The one PR an MCP response names in a `url` or `html_url` field, at any depth and inside any
 * string that is itself JSON (an MCP text part), when it is a civitai/civitai PR; else null. Text
 * that is not JSON, an error result, another repo's URL, or two PRs all give null.
 */
function mcpResponsePr(toolResponse) {
  const prs = new Set();
  let isError = false;
  const visit = (value, depth) => {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        return;
      }
      visit(parsed, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    if (value.isError === true || value.is_error === true) isError = true;
    for (const key of ['url', 'html_url']) {
      const m = typeof value[key] === 'string' ? PR_URL.exec(value[key]) : null;
      if (m) prs.add(`${m[1]}/${m[2]}#${m[3]}`.toLowerCase());
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(toolResponse, 0);
  if (isError || prs.size !== 1) return null;
  const [repo, pr] = [...prs][0].split('#');
  return repo === REPO ? Number(pr) : null;
}

/**
 * `{ action, pr, draft, headRepo? }` when a GitHub MCP call opened a civitai/civitai PR
 * (`create_pull_request`) or marked one ready (`update_pull_request` with `draft: false`), else
 * null. `headRepo` is set only when a create's `head` names a branch of civitai/civitai: GitHub reads
 * an unqualified `head` as a branch of the base repo, and `owner:branch` as a branch of owner's.
 *
 * An update sending `draft: false` for a PR that was already ready counts too: the server answers
 * both the same way.
 */
export function mcpPrEvent(toolName, toolInput, toolResponse) {
  const tool = GITHUB_MCP_PR_TOOL.exec(toolName || '');
  if (!tool || toolInput == null || typeof toolInput !== 'object') return null;
  if (`${toolInput.owner}/${toolInput.repo}`.toLowerCase() !== REPO) return null;
  const pr = mcpResponsePr(toolResponse);
  if (pr === null) return null;
  if (tool[1].toLowerCase() === 'update_pull_request') {
    if (toolInput.draft !== false || Number(toolInput.pullNumber) !== pr) return null;
    return { action: 'ready', pr, draft: false };
  }
  const event = { action: 'create', pr, draft: toolInput.draft === true };
  const head = typeof toolInput.head === 'string' ? toolInput.head : '';
  const owner = head.includes(':') ? head.slice(0, head.indexOf(':')) : 'civitai';
  if (head && owner.toLowerCase() === 'civitai') event.headRepo = REPO;
  return event;
}

/**
 * `{ action, pr, draft }` when the hook's input is a call that opened or readied a civitai/civitai
 * PR whose head is in civitai/civitai, else null. The head is read with ONE `gh api` call, made
 * only once the call qualified, and skipped when an MCP create's `head` already names this repo.
 */
export function hookEvent(input, env = process.env, deps = {}) {
  const toolName = input?.tool_name || '';
  const event = toolName.startsWith('mcp__')
    ? mcpPrEvent(toolName, input?.tool_input, input?.tool_response)
    : prEvent(input?.tool_input?.command || '', input?.tool_response);
  if (!event) return null;
  const head = event.headRepo ?? (deps.prHeadRepo ?? prHeadRepo)(event.pr, env);
  if (!head || head.toLowerCase() !== REPO) return null;
  return { action: event.action, pr: event.pr, draft: event.draft };
}

/** The context the hook adds for an event from `hookEvent`. */
export function nudge({ action, pr, draft }) {
  const ref = `${REPO}#${pr}`;
  const intent =
    `Record its intent in HQ now, before the first round finishes: with the hq CLI, ` +
    `\`hq pr-review why set ${ref} --intent "<what was asked, and why>"\`; with the HQ MCP tools, ` +
    `\`pr_review_why_set\`. The intent is internal: never put it in the PR body or a GitHub comment.`;
  const wait =
    `wait for the round: run \`hq pr-review watch ${ref}\` in the background, or call the HQ MCP ` +
    `tool \`pr_review_watch\` and do what its \`next\` says until it returns the round (stop after ` +
    `two hours without one, as the CLI watch does). Then work the round as the skill says.`;
  if (action === 'create' && draft) {
    return (
      `${ref} was opened as a draft. The hosted review (the \`pr-review\` check) skips drafts, so it ` +
      `starts when the PR is marked ready. Follow the \`pr-review\` skill. ${intent} After the PR ` +
      `is marked ready, ${wait}`
    );
  }
  const what = action === 'create' ? 'was opened' : 'was marked ready for review';
  return (
    `${ref} ${what}. The hosted review (the \`pr-review\` check) reviews every new head of it. ` +
    `Follow the \`pr-review\` skill. ${intent} Then ${wait}`
  );
}
