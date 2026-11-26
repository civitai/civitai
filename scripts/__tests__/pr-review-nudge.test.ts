import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  GITHUB_MCP_PR_TOOL,
  ghPrMatch,
  hookEvent,
  mcpPrEvent,
  nudge,
  prEvent,
} from '../../.claude/hooks/pr-review-nudge.logic.mjs';

/**
 * The PostToolUse nudge that points a session at the `pr-review` skill once a Bash or GitHub MCP
 * call has opened or readied a civitai/civitai PR. The PR number must come from what the tool
 * returned, and only for this repo: a nudge naming the wrong PR sends an agent to record intent on
 * someone else's.
 */
const event = prEvent as (
  command: string,
  toolResponse: unknown
) => {
  action: string;
  pr: number;
  draft: boolean;
} | null;
const text = nudge as (e: { action: string; pr: number; draft: boolean }) => string;

const created = (n: number, repo = 'civitai/civitai') => ({
  stdout: `https://github.com/${repo}/pull/${n}\n`,
  stderr: '',
});
// gh prints the ready line on stderr (pkg/cmd/pr/ready/ready.go).
const readied = (line: string) => ({ stdout: '', stderr: `✓ Pull request ${line}\n` });

describe('prEvent finds a PR this call opened or readied', () => {
  it.each([
    ['gh pr create --fill', 7801],
    ['gh -R civitai/civitai pr create --title x --body-file b.md', 7802],
    ['gh --repo=civitai/civitai pr create --fill', 7803],
    ['cd /tmp/wt && gh pr create --fill --base main', 7804],
    ['GH_PROMPT_DISABLED=1 gh pr create --fill', 7805],
  ])('%s', (command, n) => {
    expect(event(command, created(n))).toEqual({ action: 'create', pr: n, draft: false });
  });

  it('marks a draft create as a draft', () => {
    expect(event('gh pr create --draft --fill', created(7811))).toEqual({
      action: 'create',
      pr: 7811,
      draft: true,
    });
    expect(event('gh pr create -d --fill', created(7812))?.draft).toBe(true);
    expect(event('gh -R civitai/civitai pr create --fill --draft', created(7813))?.draft).toBe(
      true
    );
  });

  // Draft is read from the matched gh segment's own flags, after `pr create`, with quotes kept
  // whole: a `-d` anywhere else on the line is not this create's flag.
  it.each([
    ['[ -d x ] && gh pr create --fill'],
    ['git branch -d old && gh pr create --fill'],
    ['gh pr create --title "x -d y" --fill'],
    ["gh pr create --body 'see --draft' --fill"],
    ['gh pr create --draft=false --fill'],
  ])('does not mark %s as a draft', (command) => {
    expect(event(command, created(7814))).toEqual({ action: 'create', pr: 7814, draft: false });
  });

  it('reads gh pr ready from its success lines only', () => {
    expect(
      event('gh pr ready 7821', readied('civitai/civitai#7821 is marked as "ready for review"'))
    ).toEqual({ action: 'ready', pr: 7821, draft: false });
  });

  it('reads gh output from any string field of the tool_response, nested or not', () => {
    const line = '✓ Pull request civitai/civitai#7832 is marked as "ready for review"';
    expect(event('gh pr ready 7832', { content: [{ type: 'text', text: line }] })?.pr).toBe(7832);
    expect(event('gh pr create --fill', { content: created(7833).stdout })?.pr).toBe(7833);
  });

  it('takes a tool_response that is a bare string', () => {
    expect(event('gh pr create --fill', 'https://github.com/civitai/civitai/pull/7831')?.pr).toBe(
      7831
    );
  });
});

describe('prEvent fires nothing for anything else', () => {
  it.each([
    ['another repo', 'gh pr create --fill', created(41, 'civitai/civitai-app-starters')],
    ['a fork with the same name', 'gh pr create --fill', created(42, 'someone/civitai')],
    [
      'a create that printed no URL (it failed)',
      'gh pr create --fill',
      { stdout: '', stderr: 'no commits' },
    ],
    ['a command that only views a PR', 'gh pr view 43 --json url', created(43)],
    ['a create quoted in an echo', 'echo "gh pr create --fill"', created(44)],
    ['a create named in a commit message', 'git commit -m "after gh pr create"', created(45)],
    [
      'output naming two PRs',
      'gh pr create --fill',
      { stdout: `${created(46).stdout}${created(47).stdout}` },
    ],
    [
      'gh pr ready on a closed PR',
      'gh pr ready 48',
      readied(
        'civitai/civitai#48 is closed. Only draft pull requests can be marked as "ready for review"'
      ),
    ],
    [
      'gh pr ready --undo',
      'gh pr ready 49 --undo',
      readied('civitai/civitai#49 is converted to "draft"'),
    ],
    ['no response at all', 'gh pr create --fill', undefined],
    // gh's exact strings (pkg/cmd/pr/create/create.go, pkg/cmd/pr/ready/ready.go): nothing new
    // happened, so there is nothing to nudge about.
    [
      'a create refused because the PR already exists',
      'gh pr create --fill',
      {
        stdout: '',
        stderr:
          'a pull request for branch "feat/x" into branch "main" already exists:\n' +
          'https://github.com/civitai/civitai/pull/50\n',
      },
    ],
    [
      'gh pr ready on a PR that is already ready',
      'gh pr ready 51',
      readied('civitai/civitai#51 is already "ready for review"'),
    ],
  ])('%s', (_label, command, response) => {
    expect(event(command, response)).toBeNull();
  });
});

describe('ghPrMatch reads the gh segment', () => {
  const sub = (command: string) => (ghPrMatch(command) as { sub: string } | null)?.sub ?? null;

  it('takes a value only after a flag without =', () => {
    expect(sub('gh -R civitai/civitai pr ready 7')).toBe('ready');
    expect(sub('gh --repo=civitai/civitai pr create')).toBe('create');
    expect(sub('gh --repo=civitai/civitai stray pr create')).toBeNull();
  });
});

// What the GitHub MCP server answers for a created or updated PR: one text part holding
// `{"id":…,"url":<html url>}` (github-mcp-server pkg/github/pullrequests.go, MinimalResponse).
const mcpAnswer = (n: number, repo = 'civitai/civitai') => [
  {
    type: 'text',
    text: JSON.stringify({ id: '9001', url: `https://github.com/${repo}/pull/${n}` }),
  },
];
const MCP_CREATE = 'mcp__github__create_pull_request';
const MCP_UPDATE = 'mcp__github__update_pull_request';
const createArgs = (extra: Record<string, unknown> = {}) => ({
  owner: 'civitai',
  repo: 'civitai',
  title: 'x',
  head: 'feat/x',
  base: 'main',
  ...extra,
});

describe('mcpPrEvent finds a PR a GitHub MCP call opened or readied', () => {
  const mcp = mcpPrEvent as (
    toolName: string,
    toolInput: unknown,
    toolResponse: unknown
  ) => { action: string; pr: number; draft: boolean; headRepo?: string } | null;

  it('takes the PR number from the response, and a same-repo head from the input', () => {
    expect(mcp(MCP_CREATE, createArgs(), mcpAnswer(7841))).toEqual({
      action: 'create',
      pr: 7841,
      draft: false,
      headRepo: 'civitai/civitai',
    });
    expect(mcp(MCP_CREATE, createArgs({ head: 'Civitai:feat/x' }), mcpAnswer(7842))?.headRepo).toBe(
      'civitai/civitai'
    );
  });

  it('leaves the head to GitHub when the input names another owner', () => {
    expect(mcp(MCP_CREATE, createArgs({ head: 'someone:feat/x' }), mcpAnswer(7843))).toEqual({
      action: 'create',
      pr: 7843,
      draft: false,
    });
  });

  it('marks a draft create as a draft', () => {
    expect(mcp(MCP_CREATE, createArgs({ draft: true }), mcpAnswer(7844))?.draft).toBe(true);
  });

  it('reads the response in the shapes a runtime may pass it', () => {
    const answerText = mcpAnswer(7845)[0].text;
    expect(mcp(MCP_CREATE, createArgs(), answerText)?.pr).toBe(7845);
    expect(mcp(MCP_CREATE, createArgs(), { content: mcpAnswer(7846) })?.pr).toBe(7846);
    expect(
      mcp(MCP_CREATE, createArgs(), {
        id: '9001',
        html_url: 'https://github.com/civitai/civitai/pull/7847',
      })?.pr
    ).toBe(7847);
  });

  it.each([
    'mcp__github__create_pull_request',
    'mcp__plugin_github_github__create_pull_request',
    'mcp__claude_ai_GitHub__create_pull_request',
  ])('answers to the server name in %s', (toolName) => {
    expect(mcp(toolName, createArgs(), mcpAnswer(7848))?.pr).toBe(7848);
  });

  it('reads an update with draft: false as marking the PR ready', () => {
    const args = { owner: 'civitai', repo: 'civitai', pullNumber: 7851, draft: false };
    expect(mcp(MCP_UPDATE, args, mcpAnswer(7851))).toEqual({
      action: 'ready',
      pr: 7851,
      draft: false,
    });
  });

  it.each<[string, string, unknown, unknown]>([
    [
      'a create on another repo',
      MCP_CREATE,
      createArgs({ repo: 'civitai-app-starters' }),
      mcpAnswer(61, 'civitai/civitai-app-starters'),
    ],
    [
      'a create on a same-named fork',
      MCP_CREATE,
      createArgs({ owner: 'someone' }),
      mcpAnswer(62, 'someone/civitai'),
    ],
    [
      'a call on another repo whose response names a PR of this one',
      MCP_CREATE,
      createArgs({ owner: 'someone' }),
      mcpAnswer(75),
    ],
    ['a response naming another repo', MCP_CREATE, createArgs(), mcpAnswer(63, 'someone/civitai')],
    [
      'an error text that is not JSON',
      MCP_CREATE,
      createArgs(),
      [{ type: 'text', text: 'failed to create pull request: 422 Validation Failed' }],
    ],
    ['an error result', MCP_CREATE, createArgs(), { isError: true, content: mcpAnswer(64) }],
    [
      'a URL that is not a PR',
      MCP_CREATE,
      createArgs(),
      [{ type: 'text', text: '{"url":"x/65"}' }],
    ],
    ['a response naming two PRs', MCP_CREATE, createArgs(), [...mcpAnswer(66), ...mcpAnswer(67)]],
    ['no response', MCP_CREATE, createArgs(), undefined],
    ['no input', MCP_CREATE, undefined, mcpAnswer(68)],
    [
      'an update that does not touch draft',
      MCP_UPDATE,
      { owner: 'civitai', repo: 'civitai', pullNumber: 69, title: 'y' },
      mcpAnswer(69),
    ],
    [
      'an update that converts to draft',
      MCP_UPDATE,
      { owner: 'civitai', repo: 'civitai', pullNumber: 70, draft: true },
      mcpAnswer(70),
    ],
    [
      'an update whose response names another PR',
      MCP_UPDATE,
      { owner: 'civitai', repo: 'civitai', pullNumber: 71, draft: false },
      mcpAnswer(72),
    ],
    ['another GitHub tool', 'mcp__github__create_pull_request_review', createArgs(), mcpAnswer(73)],
    ['another server', 'mcp__gitlab__create_pull_request', createArgs(), mcpAnswer(74)],
  ])('fires nothing for %s', (_label, toolName, input, response) => {
    expect(mcp(toolName, input, response)).toBeNull();
  });
});

describe('hookEvent', () => {
  type Deps = { prHeadRepo: (pr: number) => string | null };
  const decide = hookEvent as (
    input: unknown,
    env: Record<string, string>,
    deps: Deps
  ) => { action: string; pr: number; draft: boolean } | null;
  const bash = (command: string, response: unknown) => ({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: response,
  });
  const mcpCall = (tool: string, input: unknown, response: unknown) => ({
    tool_name: tool,
    tool_input: input,
    tool_response: response,
  });
  const recording = (answer: string | null) => {
    const heads: number[] = [];
    return {
      heads,
      deps: {
        prHeadRepo: (pr: number) => {
          heads.push(pr);
          return answer;
        },
      },
    };
  };

  it('nudges a same-repo Bash PR in an environment with no hq at all', () => {
    const r = recording('Civitai/Civitai');
    expect(
      decide(bash('gh pr create --fill', created(7861)), { PATH: '/nowhere' }, r.deps)
    ).toEqual({ action: 'create', pr: 7861, draft: false });
    expect(r.heads).toEqual([7861]);
  });

  it('says nothing for a fork or an unreadable head', () => {
    expect(
      decide(bash('gh pr create', created(7862)), {}, recording('someone/civitai').deps)
    ).toBeNull();
    expect(decide(bash('gh pr create', created(7863)), {}, recording(null).deps)).toBeNull();
  });

  it('takes an MCP create head of this repo from the input, without reading it', () => {
    const r = recording(null);
    expect(decide(mcpCall(MCP_CREATE, createArgs(), mcpAnswer(7864)), {}, r.deps)).toEqual({
      action: 'create',
      pr: 7864,
      draft: false,
    });
    expect(r.heads).toEqual([]);
  });

  it('reads the head of an MCP create from another owner, and of an MCP ready', () => {
    const fork = recording('someone/civitai');
    const forkCall = mcpCall(MCP_CREATE, createArgs({ head: 'someone:feat/x' }), mcpAnswer(7865));
    expect(decide(forkCall, {}, fork.deps)).toBeNull();
    expect(fork.heads).toEqual([7865]);

    const ready = recording('civitai/civitai');
    const readyArgs = { owner: 'civitai', repo: 'civitai', pullNumber: 7866, draft: false };
    expect(decide(mcpCall(MCP_UPDATE, readyArgs, mcpAnswer(7866)), {}, ready.deps)?.action).toBe(
      'ready'
    );
    expect(ready.heads).toEqual([7866]);
  });

  it('never reads the head (the one network call) without a PR event', () => {
    const r = recording('civitai/civitai');
    expect(decide(bash('ls', { stdout: '' }), {}, r.deps)).toBeNull();
    expect(decide(mcpCall(MCP_CREATE, createArgs(), 'not json'), {}, r.deps)).toBeNull();
    expect(r.heads).toEqual([]);
  });
});

describe('the nudge text', () => {
  // Pinned whole: the text is the instruction an agent executes. It carries commands with the PR
  // reference spliced in and the rules the agent follows, so any change to it is a behaviour change.
  it('names the PR, the skill, and both the CLI and the MCP way to record intent and wait', () => {
    expect(text({ action: 'create', pr: 7801, draft: false })).toBe(
      'civitai/civitai#7801 was opened. The hosted review (the `pr-review` check) reviews every new ' +
        'head of it. Follow the `pr-review` skill. Record its intent in HQ now, before the first round ' +
        'finishes: with the hq CLI, `hq pr-review why set civitai/civitai#7801 --intent "<what was ' +
        'asked, and why>"`; with the HQ MCP tools, `pr_review_why_set`. The intent is internal: never ' +
        'put it in the PR body or a GitHub comment. Then wait for the round: run ' +
        '`hq pr-review watch civitai/civitai#7801` in the background, or call the HQ MCP tool ' +
        '`pr_review_watch` and do what its `next` says until it returns the round (stop after two ' +
        'hours without one, as the CLI watch does). Then work the round as the skill says.'
    );
  });

  it('tells a draft the review waits for ready, and still asks for the intent', () => {
    expect(text({ action: 'create', pr: 7811, draft: true })).toBe(
      'civitai/civitai#7811 was opened as a draft. The hosted review (the `pr-review` check) skips ' +
        'drafts, so it starts when the PR is marked ready. Follow the `pr-review` skill. Record its ' +
        'intent in HQ now, before the first round finishes: with the hq CLI, `hq pr-review why set ' +
        'civitai/civitai#7811 --intent "<what was asked, and why>"`; with the HQ MCP tools, ' +
        '`pr_review_why_set`. The intent is internal: never put it in the PR body or a GitHub ' +
        'comment. After the PR is marked ready, wait for the round: run `hq ' +
        'pr-review watch civitai/civitai#7811` in the background, or call the HQ MCP tool ' +
        '`pr_review_watch` and do what its `next` says until it returns the round (stop after two ' +
        'hours without one, as the CLI watch does). Then work the round as the skill says.'
    );
  });

  it('says a readied PR was marked ready', () => {
    expect(text({ action: 'ready', pr: 7821, draft: false })).toMatch(
      /^civitai\/civitai#7821 was marked ready for review\. /
    );
  });
});

/**
 * The hook spawned as a process, in a sandbox it cannot see past: PATH holds only a fake `gh` and,
 * when the case wants one, a fake `hq`; HOME is a fresh directory. The fake `gh` answers the head
 * repo the case names, so no case reaches the network, and only when it is asked for the head repo
 * of the PR the case created.
 *
 * The nudge is for every PR whose head is in this repo, whether or not the session has the `hq` CLI
 * (a session may reach HQ through its MCP tools only); a fork's PR gets nothing.
 */
// The fakes are `#!/bin/sh` scripts, which Windows cannot execute; the logic tests above cover it there.
describe.skipIf(process.platform === 'win32')(
  'the hook answers when it is run as a process',
  () => {
    const hook = resolve(__dirname, '../../.claude/hooks/pr-review-nudge.mjs');
    const dirs: string[] = [];
    afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
    // The PR every create case's output names.
    const PR = 7801;

    type Sandbox = { hq?: boolean; head?: string; ghFails?: boolean };
    const sandbox = ({ hq = false, head = 'civitai/civitai', ghFails }: Sandbox = {}) => {
      const root = mkdtempSync(join(tmpdir(), 'pr-review-nudge-'));
      dirs.push(root);
      const bin = join(root, 'bin');
      const home = join(root, 'home');
      const ghLog = join(root, 'gh-argv');
      mkdirSync(bin);
      mkdirSync(home);
      // The fake records every argv it is given, one argument per line, and exits 97 on any argv but
      // the head-repo read for `PR`, so a hook that asks gh the wrong question gets no answer.
      const answer = ghFails ? 'echo "HTTP 404" >&2; exit 1' : `echo '${head}'`;
      const gh = [
        '#!/bin/sh',
        `printf '%s\\n' "$@" >> '${ghLog}'`,
        `if [ "$#" -ne 4 ] || [ "$1" != api ] || [ "$2" != repos/civitai/civitai/pulls/${PR} ] || ` +
          `[ "$3" != --jq ] || [ "$4" != .head.repo.full_name ]; then`,
        '  echo "fake gh: unexpected argv: $*" >&2',
        '  exit 97',
        'fi',
        answer,
      ].join('\n');
      writeFileSync(join(bin, 'gh'), `${gh}\n`, { mode: 0o755 });
      if (hq) {
        writeFileSync(join(bin, 'hq'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        mkdirSync(join(home, '.config', 'hq'), { recursive: true });
        writeFileSync(join(home, '.config', 'hq', 'config.toml'), 'token = "hq_test_token"\n');
      }
      const env: Record<string, string> = { PATH: bin, HOME: home };
      // Everything the fake gh was called with, '' when it never ran.
      const ghArgv = () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : '');
      return { env, ghArgv };
    };
    // The one gh call the hook makes: the head-repo read for `PR`, as `prHeadRepo` builds it.
    const HEAD_READ = ['api', `repos/civitai/civitai/pulls/${PR}`, '--jq', '.head.repo.full_name']
      .map((arg) => `${arg}\n`)
      .join('');

    const run = (input: string, env: Record<string, string>, timeout = 30_000) =>
      spawnSync(process.execPath, [hook], { input, encoding: 'utf8', timeout, env });
    const createInput = (command = 'gh pr create --fill') =>
      JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: created(PR) });
    const mcpCreateInput = (
      args: Record<string, unknown> = {},
      response: unknown = mcpAnswer(PR)
    ) =>
      JSON.stringify({
        tool_name: MCP_CREATE,
        tool_input: createArgs(args),
        tool_response: response,
      });
    const context = (stdout: string) => {
      const out = JSON.parse(stdout).hookSpecificOutput;
      expect(out.hookEventName).toBe('PostToolUse');
      return out.additionalContext;
    };
    const NUDGE = text({ action: 'create', pr: PR, draft: false });
    const DRAFT_NUDGE = text({ action: 'create', pr: PR, draft: true });

    // A session that reaches HQ only through its MCP tools has no `hq` binary and no hq config.
    it('adds the nudge after a create in a session without the hq CLI', () => {
      const box = sandbox();
      const r = run(createInput(), box.env);
      expect(box.ghArgv(), 'the hook asked gh something other than the head repo of PR ' + PR).toBe(
        HEAD_READ
      );
      expect(r.status).toBe(0);
      expect(context(r.stdout)).toBe(NUDGE);
    });

    it('adds the same nudge when hq is installed and signed in', () => {
      const box = sandbox({ hq: true });
      const r = run(createInput(), box.env);
      expect(box.ghArgv()).toBe(HEAD_READ);
      expect(context(r.stdout)).toBe(NUDGE);
    });

    it('adds the draft nudge after gh pr create --draft', () => {
      const r = run(createInput('gh pr create --draft --fill'), sandbox().env);
      expect(context(r.stdout)).toBe(DRAFT_NUDGE);
    });

    it('adds the nudge after a GitHub MCP create, with no gh call for a same-repo head', () => {
      const box = sandbox({ ghFails: true });
      const r = run(mcpCreateInput(), box.env);
      expect(box.ghArgv()).toBe('');
      expect(r.status).toBe(0);
      expect(context(r.stdout)).toBe(NUDGE);
    });

    it('adds the draft nudge after a GitHub MCP draft create', () => {
      const r = run(mcpCreateInput({ draft: true }), sandbox().env);
      expect(context(r.stdout)).toBe(DRAFT_NUDGE);
    });

    it.each<[string, Sandbox, string, string]>([
      ['a Bash PR comes from a fork', { head: 'someone/civitai' }, createInput(), HEAD_READ],
      ['the head repo cannot be read', { ghFails: true }, createInput(), HEAD_READ],
      [
        'a GitHub MCP PR comes from a fork',
        { head: 'someone/civitai' },
        mcpCreateInput({ head: 'someone:feat/x' }),
        HEAD_READ,
      ],
      [
        'a GitHub MCP create is on another repo',
        {},
        mcpCreateInput(
          { repo: 'civitai-app-starters' },
          mcpAnswer(PR, 'civitai/civitai-app-starters')
        ),
        '',
      ],
      [
        'a GitHub MCP response cannot be parsed',
        {},
        mcpCreateInput({}, [{ type: 'text', text: 'failed to create pull request' }]),
        '',
      ],
    ])('says nothing and exits 0 when %s', (_label, opts, input, ghArgv) => {
      const box = sandbox(opts);
      const r = run(input, box.env);
      expect(box.ghArgv()).toBe(ghArgv);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it.each([
      [
        'an unrelated command',
        JSON.stringify({ tool_input: { command: 'ls' }, tool_response: { stdout: '' } }),
      ],
      ['input that is not JSON', '{not json'],
      ['no input', ''],
    ])('says nothing and exits 0 for %s', (_label, input) => {
      const box = sandbox();
      const r = run(input, box.env);
      expect(box.ghArgv()).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    // The scanner runs on every Bash call, so a long run of flags must not slow the hook. These are
    // the file's only long-input cases, and they run the hook in a child with a time limit: a
    // scanner that is too slow gets the child killed and fails here, rather than blocking the worker.
    const HOOK_LIMIT_MS = 5_000;
    it.each([
      ['a long flag run with no pr subcommand', `gh${' --flag'.repeat(40)} x`, ''],
      [
        'a long flag run before pr create',
        `gh${' --flag'.repeat(40)} pr create --fill`,
        `${JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: NUDGE },
        })}\n`,
      ],
    ])('answers within the time limit for %s', (_label, command, stdout) => {
      const r = run(createInput(command), sandbox().env, HOOK_LIMIT_MS);
      expect(r.signal, `the hook did not exit within ${HOOK_LIMIT_MS} ms`).toBeNull();
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(stdout);
    });
  }
);

// The settings.json matcher decides whether the hook runs at all, and the logic regex decides
// whether it nudges. A tool name one accepts and the other rejects is a silent miss, so the two
// are pinned to the same answer over every name shape the hook claims to handle, and over the
// names it must refuse.
describe('the settings.json MCP matcher and the logic regex agree', () => {
  const settings = JSON.parse(
    readFileSync(resolve(__dirname, '../../.claude/settings.json'), 'utf8')
  );
  const matchers = (settings.hooks.PostToolUse as { matcher: string }[])
    .map((h) => h.matcher)
    .filter((m) => m.includes('pull_request'));
  const names: [string, boolean][] = [
    ['mcp__github__create_pull_request', true],
    ['mcp__github__update_pull_request', true],
    ['mcp__GitHub__create_pull_request', true],
    ['mcp__GITHUB__create_pull_request', true],
    ['mcp__plugin_github_github__update_pull_request', true],
    ['mcp__claude_ai_GitHub__create_pull_request', true],
    ['mcp__github__create_pull_request_review', false],
    ['mcp__github__update_pull_request_draft_state', false],
    ['mcp__gitlab__create_pull_request', false],
    ['xmcp__github__create_pull_request', false],
    ['Bash', false],
  ];

  it('has exactly one MCP pull-request matcher', () => {
    expect(matchers).toHaveLength(1);
  });

  it.each(names)('%s: matcher and logic both say %s', (name, want) => {
    expect(new RegExp(matchers[0]).test(name)).toBe(want);
    expect(GITHUB_MCP_PR_TOOL.test(name)).toBe(want);
  });
});
