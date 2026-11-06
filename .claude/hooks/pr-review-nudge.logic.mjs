/**
 * Every decision the PostToolUse pr-review nudge makes. The hook itself is pr-review-nudge.mjs,
 * stdin wiring around this file, split out so a test can import it (as check-writable.logic.mjs).
 *
 * It fires when a Bash call has just opened a civitai/civitai PR (`gh pr create`) or marked one
 * ready (`gh pr ready`), and tells the session to follow the `pr-review` skill: record the PR's
 * intent in HQ before the hosted review's first round finishes, then wait for that round and work
 * its findings. It only adds context; it never blocks a command.
 *
 * The hosted review covers enrolled team members, who use HQ, so the nudge needs all three, checked
 * cheapest first (`nudgeEvent`):
 *   1. the call opened or readied exactly one civitai/civitai PR (`prEvent`: the command and what
 *      gh printed, no I/O). This is the only check every Bash call pays for;
 *   2. `hq` is installed and signed in (`hqSignedIn`: PATH and the config file, no network);
 *   3. the PR's head is in civitai/civitai, not a fork (`prHeadRepo`: ONE `gh api` read, made only
 *      once 1 and 2 hold). gh prints the base repo's URL for a fork's PR too, so the URL cannot say.
 * Any check that fails or cannot run means no nudge, silently.
 *
 * The PR number comes from what gh PRINTED, never from the command: `gh pr create` prints the new
 * PR's URL, and `gh pr ready` prints `Pull request civitai/civitai#<n> is marked as "ready for
 * review"` (on stderr). Two of gh's other answers name a PR too, and are excluded by their own
 * words because nothing just happened: a create refused with `a pull request for branch "…" into
 * branch "…" already exists:` and the existing PR's URL, and a ready that says the PR `is already
 * "ready for review"`. A gh command quoted in an echo or a commit message is not a gh segment
 * (`ghPrMatch`), so it fires nothing whatever was printed.
 */

import { spawnSync } from 'child_process';
import { accessSync, constants, readFileSync } from 'fs';
import { delimiter, join } from 'path';

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
    // MUTATION (temporary, reverted in the next commit): cost exponential in the flag count.
    const blowUp = (n) => (n <= 0 ? 1 : blowUp(n - 1) + blowUp(n - 1));
    blowUp(words.filter((w) => w.startsWith('-')).length);
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

/** `'create'` or `'ready'` (`ghPrMatch`'s subcommand), else null. */
export function ghPrSubcommand(command) {
  return ghPrMatch(command)?.sub ?? null;
}

/**
 * Whether the create's own words ask for a draft (`-d`, `--draft`, `--draft=true`). Read from the
 * matched segment only, as whole words: gh prints its "Creating draft pull request" line only to a
 * terminal, so a tool call's output cannot say.
 */
function asksForDraft(args) {
  return args.some((w) => w === '-d' || w === '--draft' || w === '--draft=true');
}

// The PR as gh prints it. The owner/name must be EXACTLY civitai/civitai: a fork, or another repo
// whose name starts with "civitai", is a different repo.
const CREATED_URL =
  /https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)(?![0-9])/g;
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

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * True when `hq` is on PATH and has a token: `HQ_TOKEN`, else the `token` in hq's config file
 * (`$XDG_CONFIG_HOME/hq/config.toml`, else `$HOME/.config/hq/config.toml`, the paths and the order
 * the CLI itself reads). It makes no network call, so it cannot tell whether HQ still accepts the
 * token; a rejected one shows as an auth error on the skill's first command.
 */
export function hqSignedIn(env = process.env, io = { isExecutable, readText }) {
  const names = process.platform === 'win32' ? ['hq.exe', 'hq'] : ['hq'];
  const dirs = (env.PATH || '').split(delimiter).filter(Boolean);
  if (!dirs.some((dir) => names.some((name) => io.isExecutable(join(dir, name))))) return false;
  if ((env.HQ_TOKEN || '').trim()) return true;
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : '');
  if (!base) return false;
  const m = /^\s*token\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/m.exec(
    io.readText(join(base, 'hq', 'config.toml'))
  );
  return Boolean(m && (m[1] ?? m[2]).trim());
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

/** `prEvent`'s event when all three checks in the header hold, else null. */
export function nudgeEvent(command, toolResponse, env = process.env, deps = {}) {
  const event = prEvent(command, toolResponse);
  if (!event) return null;
  if (!(deps.hqSignedIn ?? hqSignedIn)(env)) return null;
  const head = (deps.prHeadRepo ?? prHeadRepo)(event.pr, env);
  return head && head.toLowerCase() === REPO ? event : null;
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
