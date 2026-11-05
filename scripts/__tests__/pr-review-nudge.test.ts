import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ghPrSubcommand,
  hqSignedIn,
  nudge,
  nudgeEvent,
  prEvent,
} from '../../.claude/hooks/pr-review-nudge.logic.mjs';

/**
 * The PostToolUse nudge that points a session at the `pr-review` skill once a Bash call has
 * opened or readied a civitai/civitai PR. The PR number must come from what gh printed, and only
 * for this repo: a nudge naming the wrong PR sends an agent to record intent on someone else's.
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
  });

  it('reads gh pr ready from its success lines only', () => {
    expect(
      event('gh pr ready 7821', readied('civitai/civitai#7821 is marked as "ready for review"'))
    ).toEqual({ action: 'ready', pr: 7821, draft: false });
    expect(
      event('gh pr ready 7822', readied('civitai/civitai#7822 is already "ready for review"'))?.pr
    ).toBe(7822);
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
  ])('%s', (_label, command, response) => {
    expect(event(command, response)).toBeNull();
  });
});

describe('ghPrSubcommand scans the command in linear time', () => {
  const sub = ghPrSubcommand as (command: string) => string | null;

  it('finds pr create after 40 flags, and gives up on 40 flags with no pr', () => {
    expect(sub(`gh${' --flag'.repeat(40)} pr create --fill`)).toBe('create');
    expect(sub(`gh${' --flag'.repeat(40)} x`)).toBeNull();
  });

  it('takes a value only after a flag without =', () => {
    expect(sub('gh -R civitai/civitai pr ready 7')).toBe('ready');
    expect(sub('gh --repo=civitai/civitai pr create')).toBe('create');
    expect(sub('gh --repo=civitai/civitai stray pr create')).toBeNull();
  });
});

describe('hqSignedIn reads PATH and the hq config, with no network', () => {
  type Io = { isExecutable: (p: string) => boolean; readText: (p: string) => string };
  const signedIn = hqSignedIn as (env: Record<string, string>, io: Io) => boolean;
  const io = (hqAt: string | null, files: Record<string, string> = {}): Io => ({
    isExecutable: (p) => hqAt !== null && p === `${hqAt}/hq`,
    readText: (p) => files[p] ?? '',
  });

  it('needs hq on PATH', () => {
    expect(signedIn({ PATH: '/a:/b', HQ_TOKEN: 't' }, io('/b'))).toBe(true);
    expect(signedIn({ PATH: '/a', HQ_TOKEN: 't' }, io('/b'))).toBe(false);
  });

  it('reads the token from XDG_CONFIG_HOME before HOME, as the CLI does', () => {
    const files = {
      '/xdg/hq/config.toml': "token = 'from-xdg'\n",
      '/home/u/.config/hq/config.toml': 'token = ""\n',
    };
    expect(
      signedIn({ PATH: '/b', XDG_CONFIG_HOME: '/xdg', HOME: '/home/u' }, io('/b', files))
    ).toBe(true);
    expect(signedIn({ PATH: '/b', HOME: '/home/u' }, io('/b', files))).toBe(false);
  });

  it('is false with no token anywhere', () => {
    expect(signedIn({ PATH: '/b', HOME: '/home/u' }, io('/b'))).toBe(false);
    expect(signedIn({ PATH: '/b', HQ_TOKEN: '  ' }, io('/b'))).toBe(false);
  });
});

describe('nudgeEvent checks cheapest first', () => {
  type Deps = { hqSignedIn: () => boolean; prHeadRepo: (pr: number) => string | null };
  const decide = nudgeEvent as (
    command: string,
    toolResponse: unknown,
    env: Record<string, string>,
    deps: Deps
  ) => { action: string; pr: number } | null;

  it('nudges a same-repo PR when hq is signed in', () => {
    const heads: number[] = [];
    const deps = {
      hqSignedIn: () => true,
      prHeadRepo: (pr: number) => {
        heads.push(pr);
        return 'Civitai/Civitai';
      },
    };
    expect(decide('gh pr create --fill', created(7801), {}, deps)?.pr).toBe(7801);
    expect(heads).toEqual([7801]);
  });

  it('says nothing for a fork or an unreadable head', () => {
    expect(
      decide(
        'gh pr create',
        created(7802),
        {},
        { hqSignedIn: () => true, prHeadRepo: () => 'someone/civitai' }
      )
    ).toBeNull();
    expect(
      decide('gh pr create', created(7803), {}, { hqSignedIn: () => true, prHeadRepo: () => null })
    ).toBeNull();
  });

  it('never reads the head (the one network call) without hq, or without a PR event', () => {
    const heads: number[] = [];
    const prHeadRepo = (pr: number) => {
      heads.push(pr);
      return 'civitai/civitai';
    };
    expect(
      decide('gh pr create', created(7804), {}, { hqSignedIn: () => false, prHeadRepo })
    ).toBeNull();
    expect(decide('ls', { stdout: '' }, {}, { hqSignedIn: () => true, prHeadRepo })).toBeNull();
    expect(heads).toEqual([]);
  });
});

describe('the nudge text', () => {
  // Pinned whole: an agent acts on these words, so a reword is a change that should show in review.
  it('names the PR, the skill, the intent command and the watch', () => {
    expect(text({ action: 'create', pr: 7801, draft: false })).toBe(
      'civitai/civitai#7801 was opened. The hosted review (the `pr-review` check) reviews every new ' +
        'head of it. Follow the `pr-review` skill. Record its intent in HQ now, before the first round ' +
        'finishes: `hq pr-review why set civitai/civitai#7801 --intent "<what was asked, and why>"` ' +
        '(or the HQ MCP tool `pr_review_why_set`). The intent is internal: never put it in the PR ' +
        'body or a GitHub comment. Then run `hq pr-review watch civitai/civitai#7801` in the ' +
        'background and, when it returns, work the round as the skill says.'
    );
  });

  it('tells a draft the review waits for ready, and still asks for the intent', () => {
    expect(text({ action: 'create', pr: 7811, draft: true })).toBe(
      'civitai/civitai#7811 was opened as a draft. The hosted review (the `pr-review` check) skips ' +
        'drafts, so it starts when the PR is marked ready. Follow the `pr-review` skill. Record its ' +
        'intent in HQ now, before the first round finishes: `hq pr-review why set ' +
        'civitai/civitai#7811 --intent "<what was asked, and why>"` (or the HQ MCP tool ' +
        '`pr_review_why_set`). The intent is internal: never put it in the PR body or a GitHub ' +
        'comment. Run the watch after `gh pr ready`.'
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
 * repo the case names, so no case reaches the network.
 *
 * The nudge is for authors who use HQ, on PRs whose head is in this repo: a fork's PR and a session
 * without a signed-in `hq` get nothing.
 */
describe('the hook answers when it is run as a process', () => {
  const hook = resolve(__dirname, '../../.claude/hooks/pr-review-nudge.mjs');
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  type Sandbox = {
    hq?: boolean;
    config?: string;
    hqToken?: string;
    head?: string;
    ghFails?: boolean;
  };
  const sandbox = ({ hq = true, config, hqToken, head = 'civitai/civitai', ghFails }: Sandbox) => {
    const root = mkdtempSync(join(tmpdir(), 'pr-review-nudge-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    const home = join(root, 'home');
    mkdirSync(bin);
    mkdirSync(home);
    const gh = ghFails ? 'echo "HTTP 404" >&2; exit 1' : `echo '${head}'`;
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${gh}\n`, { mode: 0o755 });
    if (hq) writeFileSync(join(bin, 'hq'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    if (config !== undefined) {
      mkdirSync(join(home, '.config', 'hq'), { recursive: true });
      writeFileSync(join(home, '.config', 'hq', 'config.toml'), config);
    }
    const env: Record<string, string> = { PATH: bin, HOME: home };
    if (hqToken !== undefined) env.HQ_TOKEN = hqToken;
    return env;
  };
  const SIGNED_IN = 'url = "https://hq.civitai.com"\ntoken = "hq_test_token"\n';

  const run = (input: string, env: Record<string, string>, timeout = 30_000) =>
    spawnSync(process.execPath, [hook], { input, encoding: 'utf8', timeout, env });
  const createInput = (command = 'gh pr create --fill') =>
    JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: created(7801) });

  it('adds the nudge after a create when hq is signed in and the head is in this repo', () => {
    const r = run(createInput(), sandbox({ config: SIGNED_IN }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe('PostToolUse');
    expect(out.additionalContext).toBe(text({ action: 'create', pr: 7801, draft: false }));
  });

  it('counts an HQ_TOKEN in the environment as signed in', () => {
    const r = run(createInput(), sandbox({ hqToken: 'hq_test_token' }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe(
      text({ action: 'create', pr: 7801, draft: false })
    );
  });

  it.each<[string, Sandbox]>([
    ['the PR comes from a fork', { config: SIGNED_IN, head: 'someone/civitai' }],
    ['the head repo cannot be read', { config: SIGNED_IN, ghFails: true }],
    ['hq is not installed', { hq: false, config: SIGNED_IN }],
    ['hq is installed but not signed in', { config: 'url = "https://hq.civitai.com"\n' }],
    ['hq has an empty token', { config: 'token = ""\n', hqToken: '' }],
  ])('says nothing and exits 0 when %s', (_label, box) => {
    const r = run(createInput(), sandbox(box));
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
    const r = run(input, sandbox({ config: SIGNED_IN }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  // The matcher runs on EVERY Bash call, so its cost must grow linearly with the command. A
  // backtracking pattern took 210 ms at 24 `--flag` tokens and doubled with each one, so 40 would
  // hold the session for hours. Spawned with a timeout: a hung matcher kills the child, not the suite.
  it.each([
    ['a long flag run with no pr subcommand', `gh${' --flag'.repeat(40)} x`],
    ['a long flag run before pr create', `gh${' --flag'.repeat(40)} pr create --fill`],
  ])('answers at once for %s', (_label, command) => {
    const r = run(createInput(command), sandbox({ config: SIGNED_IN }), 5_000);
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
  });
});
