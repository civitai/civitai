import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// This repo is public. A job on a self-hosted runner executes whatever the triggering commit
// contains, so a pull_request from a fork, or a bot's dependency-update branch (its packages'
// install scripts run with sudo), must never land on one. Every job that names the
// self-hosted label must use exactly this gate; anything else (a bare label, a hand-written
// variant) fails here.
const SELF_HOSTED = 'civitai-dc';
const gate = (fallback: string) =>
  "${{ github.repository == 'civitai/civitai' && vars.CIVITAI_DC_OFF != 'true' && " +
  "!endsWith(github.actor, '[bot]') && !endsWith(github.event.pull_request.user.login || '', '[bot]') && " +
  "(github.event_name == 'push' || github.event_name == 'workflow_dispatch' || " +
  "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && " +
  "(github.event.pull_request.author_association == 'OWNER' || github.event.pull_request.author_association == 'MEMBER'))) " +
  `&& '${SELF_HOSTED}' || '${fallback}' }}`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(HERE, '../../.github/workflows');

type Job = { 'runs-on'?: unknown; permissions?: unknown };
type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> };

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((file) => ({
    file,
    doc: parse(readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')) as Workflow,
  }));

const selfHostedJobs = workflows.flatMap(({ file, doc }) =>
  Object.entries(doc.jobs ?? {})
    .filter(([, job]) => JSON.stringify(job['runs-on'] ?? '').includes(SELF_HOSTED))
    .map(([name, job]) => ({ file, name, job, runsOn: job['runs-on'], on: doc.on ?? {} }))
);

// Evaluates the gate the way the Actions expression engine does for this subset: property
// lookups on a missing object give null, `==`/`!=` compare, and `&&`/`||` return an operand.
function evaluate(expr: string, ctx: { github: unknown; vars: Record<string, string> }) {
  const endsWith = (s: unknown, suffix: string) =>
    String(s ?? '')
      .toLowerCase()
      .endsWith(suffix.toLowerCase());
  const body = expr
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/!=/g, '!==')
    .replace(/(?<![!=])==(?!=)/g, '===')
    .replace(
      /\b(github|vars)((?:\.[\w-]+)+)/g,
      (_, root: string, rest: string) => `(${root}${rest.replace(/\./g, '?.')} ?? null)`
    );
  return new Function('github', 'vars', 'endsWith', `return (${body});`)(
    ctx.github,
    ctx.vars,
    endsWith
  ) as string;
}

const repo = 'civitai/civitai';
const pr = (
  headRepo: string | null,
  author = 'someone',
  actor = author,
  association = 'MEMBER'
) => ({
  repository: repo,
  event_name: 'pull_request',
  actor,
  event: {
    pull_request: {
      user: { login: author },
      author_association: association,
      head: { repo: headRepo === null ? null : { full_name: headRepo } },
    },
  },
});

describe('self-hosted runner gate', () => {
  it('finds the jobs it guards', () => {
    expect(selfHostedJobs.length).toBeGreaterThan(0);
  });

  it.each(selfHostedJobs)('$file → $name uses the fork-safe gate', ({ runsOn }) => {
    expect(typeof runsOn).toBe('string');
    const fallback = /\|\| '([^']+)' \}\}$/.exec(runsOn as string)?.[1] ?? '';
    expect(fallback).toMatch(/^ubuntu-/);
    expect(runsOn).toBe(gate(fallback));
  });

  it.each(selfHostedJobs)('$file → $name is in a workflow with no privileged trigger', ({ on }) => {
    const triggers = Object.keys(on);
    expect(triggers).not.toContain('pull_request_target');
    expect(triggers).not.toContain('workflow_run');
  });

  // A runner whose lifetime is not ours to guarantee must not hold a write token or a secret.
  it.each(selfHostedJobs)('$file → $name holds no write permission and no secret', ({ job }) => {
    expect(JSON.stringify(job.permissions ?? {})).not.toMatch(/write/);
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|github\.token/);
  });

  const cases: Array<[string, unknown, Record<string, string>, string]> = [
    ['fork pull_request', pr('someone/civitai'), {}, 'ubuntu-latest'],
    ['pull_request whose fork was deleted', pr(null), {}, 'ubuntu-latest'],
    ['same-repo pull_request', pr(repo), {}, SELF_HOSTED],
    [
      'same-repo pull_request by an outside collaborator',
      pr(repo, 'someone', 'someone', 'COLLABORATOR'),
      {},
      'ubuntu-latest',
    ],
    [
      'same-repo pull_request by an owner',
      pr(repo, 'someone', 'someone', 'OWNER'),
      {},
      SELF_HOSTED,
    ],
    ['dependabot pull_request', pr(repo, 'dependabot[bot]'), {}, 'ubuntu-latest'],
    ['renovate pull_request', pr(repo, 'renovate[bot]'), {}, 'ubuntu-latest'],
    [
      'a person pushing to a bot pull_request',
      pr(repo, 'renovate[bot]', 'someone'),
      {},
      'ubuntu-latest',
    ],
    [
      'push by a bot',
      { repository: repo, event_name: 'push', actor: 'renovate[bot]', event: {} },
      {},
      'ubuntu-latest',
    ],
    ['push', { repository: repo, event_name: 'push', event: {} }, {}, SELF_HOSTED],
    [
      'workflow_dispatch',
      { repository: repo, event_name: 'workflow_dispatch', event: {} },
      {},
      SELF_HOSTED,
    ],
    [
      'pull_request_target',
      { repository: repo, event_name: 'pull_request_target', event: {} },
      {},
      'ubuntu-latest',
    ],
    [
      'push inside a fork',
      { repository: 'someone/civitai', event_name: 'push', event: {} },
      {},
      'ubuntu-latest',
    ],
    [
      'kill switch on',
      { repository: repo, event_name: 'push', event: {} },
      { CIVITAI_DC_OFF: 'true' },
      'ubuntu-latest',
    ],
  ];

  it.each(cases)('%s', (_label, github, vars, expected) => {
    expect(evaluate(gate('ubuntu-latest'), { github, vars })).toBe(expected);
  });
});
