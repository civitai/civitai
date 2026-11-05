import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { nudge, prEvent } from '../../.claude/hooks/pr-review-nudge.logic.mjs';

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

describe('the hook answers when it is run as a process', () => {
  const hook = resolve(__dirname, '../../.claude/hooks/pr-review-nudge.mjs');
  const run = (input: string) =>
    spawnSync(process.execPath, [hook], { input, encoding: 'utf8', timeout: 30_000 });

  it('adds the nudge as PostToolUse context after a create', () => {
    const r = run(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --fill' },
        tool_response: created(7801),
      })
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    expect(out.hookEventName).toBe('PostToolUse');
    expect(out.additionalContext).toBe(text({ action: 'create', pr: 7801, draft: false }));
  });

  it.each([
    [
      'an unrelated command',
      JSON.stringify({ tool_input: { command: 'ls' }, tool_response: { stdout: '' } }),
    ],
    ['input that is not JSON', '{not json'],
    ['no input', ''],
  ])('says nothing and exits 0 for %s', (_label, input) => {
    const r = run(input);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
