import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// This repo is public: a job on a self-hosted runner executes whatever the triggering commit
// contains, so fork PRs and bot branches must never land on one. Every job naming the
// self-hosted label must use exactly this gate.
const SELF_HOSTED = 'civitai-dc';
// A workflow whose dispatch declares a `runner` input (auto|dc) may let a dispatch with runner=dc
// past the CIVITAI_DC_OFF kill switch; nothing else gets past it.
const KILL_SWITCH = "vars.CIVITAI_DC_OFF != 'true'";
const DISPATCH_OVERRIDE =
  "(vars.CIVITAI_DC_OFF != 'true' || (github.event_name == 'workflow_dispatch' && inputs.runner == 'dc'))";
const gate = (fallback: string, override = false) =>
  "${{ github.repository == 'civitai/civitai' && " +
  (override ? DISPATCH_OVERRIDE : KILL_SWITCH) +
  ' && ' +
  "!endsWith(github.actor, '[bot]') && !endsWith(github.event.pull_request.user.login || '', '[bot]') && " +
  "(github.event_name == 'push' || github.event_name == 'workflow_dispatch' || " +
  "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && " +
  "(github.event.pull_request.author_association == 'OWNER' || github.event.pull_request.author_association == 'MEMBER'))) " +
  `&& '${SELF_HOSTED}' || '${fallback}' }}`;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(HERE, '../../.github/workflows');

type Job = { 'runs-on'?: unknown; permissions?: unknown };
type Workflow = {
  on?:
    | string
    | string[]
    | {
        workflow_dispatch?: {
          inputs?: Record<string, { type?: string; options?: string[] }>;
        } | null;
        [trigger: string]: unknown;
      };
  permissions?: unknown;
  jobs?: Record<string, Job>;
};

const triggersOf = (on: Workflow['on']) =>
  typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((file) => ({
    file,
    doc: parse(readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')) as Workflow,
  }));

const selfHostedJobs = workflows.flatMap(({ file, doc }) =>
  Object.entries(doc.jobs ?? {})
    .filter(([, job]) => JSON.stringify(job['runs-on'] ?? '').includes(SELF_HOSTED))
    .map(([name, job]) => ({
      file,
      name,
      job,
      runsOn: job['runs-on'],
      triggers: triggersOf(doc.on),
      runnerInput:
        typeof doc.on === 'object' && !Array.isArray(doc.on)
          ? doc.on.workflow_dispatch?.inputs?.runner
          : undefined,
      workflowPermissions: doc.permissions,
    }))
);

// Evaluates the gate the way the Actions expression engine does for this subset: property
// lookups on a missing object give null, `==`/`!=` compare, and `&&`/`||` return an operand.
function evaluate(
  expr: string,
  ctx: { github: unknown; vars: Record<string, string>; inputs?: Record<string, string> }
) {
  const endsWith = (s: unknown, suffix: string) =>
    String(s ?? '')
      .toLowerCase()
      .endsWith(suffix.toLowerCase());
  const body = expr
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/!=/g, '!==')
    .replace(/(?<![!=])==(?!=)/g, '===')
    .replace(
      /\b(github|vars|inputs)((?:\.[\w-]+)+)/g,
      (_, root: string, rest: string) => `(${root}${rest.replace(/\./g, '?.')} ?? null)`
    );
  return new Function('github', 'vars', 'inputs', 'endsWith', `return (${body});`)(
    ctx.github,
    ctx.vars,
    ctx.inputs ?? {},
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

  it.each(selfHostedJobs)('$file → $name uses the fork-safe gate', ({ runsOn, runnerInput }) => {
    expect(typeof runsOn).toBe('string');
    const fallback = /\|\| '([^']+)' \}\}$/.exec(runsOn as string)?.[1] ?? '';
    expect(fallback).toMatch(/^ubuntu-/);
    expect(runsOn).toBe(gate(fallback, runnerInput !== undefined));
  });

  // The override reads inputs.runner, which only a dispatch sets: as a choice of exactly
  // auto|dc, a typo cannot silently mean "kill switch ignored".
  it.each(selfHostedJobs.filter((j) => j.runnerInput !== undefined))(
    '$file declares runner as a choice of auto or dc',
    ({ runnerInput }) => {
      expect(runnerInput).toMatchObject({
        type: 'choice',
        default: 'auto',
        options: ['auto', 'dc'],
      });
    }
  );

  it('lets a lint.yml dispatch reach civitai-dc while the kill switch is on', () => {
    const unit = selfHostedJobs.find((j) => j.file === 'lint.yml' && j.name === 'unit');
    expect(unit?.runsOn).toBe(gate('ubuntu-latest', true));
  });

  it.each(selfHostedJobs)(
    '$file → $name is in a workflow with no privileged trigger',
    ({ triggers }) => {
      expect(triggers).not.toContain('pull_request_target');
      expect(triggers).not.toContain('workflow_run');
    }
  );

  // A runner whose lifetime is not ours to guarantee must not hold a write token or a secret.
  it.each(selfHostedJobs)(
    '$file → $name holds no write permission and no secret',
    ({ job, workflowPermissions }) => {
      expect(workflowPermissions).toBeDefined();
      expect(JSON.stringify(workflowPermissions)).not.toMatch(/write/);
      expect(JSON.stringify(job.permissions ?? {})).not.toMatch(/write/);
      expect(JSON.stringify(job)).not.toMatch(/secrets\.|github\.token/);
    }
  );

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
    // With no runner=dc, the override gate decides every case the same way.
    expect(evaluate(gate('ubuntu-latest', true), { github, vars })).toBe(expected);
    expect(
      evaluate(gate('ubuntu-latest', true), { github, vars, inputs: { runner: 'auto' } })
    ).toBe(expected);
  });

  const off = { CIVITAI_DC_OFF: 'true' };
  const dispatch = (actor = 'someone', repository = repo) => ({
    repository,
    event_name: 'workflow_dispatch',
    actor,
    event: {},
  });
  // `inputs` is empty on every event but a dispatch; these give the other events runner=dc anyway,
  // so dropping the event_name check from the override turns the same-repo pull_request and push
  // cases red.
  const overrideCases: Array<[string, unknown, Record<string, string>, string]> = [
    ['dispatch with runner=dc, kill switch on', dispatch(), off, SELF_HOSTED],
    ['dispatch with runner=dc, kill switch off', dispatch(), {}, SELF_HOSTED],
    [
      'dispatch by a bot with runner=dc, kill switch on',
      dispatch('renovate[bot]'),
      off,
      'ubuntu-latest',
    ],
    [
      'dispatch in a fork with runner=dc, kill switch on',
      dispatch('someone', 'someone/civitai'),
      off,
      'ubuntu-latest',
    ],
    ['same-repo pull_request with runner=dc, kill switch on', pr(repo), off, 'ubuntu-latest'],
    ['fork pull_request with runner=dc', pr('someone/civitai'), {}, 'ubuntu-latest'],
    [
      'push with runner=dc, kill switch on',
      { repository: repo, event_name: 'push', event: {} },
      off,
      'ubuntu-latest',
    ],
    [
      'pull_request_target with runner=dc, kill switch on',
      { repository: repo, event_name: 'pull_request_target', event: {} },
      off,
      'ubuntu-latest',
    ],
  ];

  it.each(overrideCases)('%s', (_label, github, vars, expected) => {
    expect(evaluate(gate('ubuntu-latest', true), { github, vars, inputs: { runner: 'dc' } })).toBe(
      expected
    );
  });
});
