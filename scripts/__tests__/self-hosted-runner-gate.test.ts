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

type Job = {
  'runs-on'?: unknown;
  permissions?: unknown;
  services?: Record<string, Service>;
  env?: Record<string, string>;
};
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
  const format = (template: string, ...args: unknown[]) =>
    template.replace(/\{\{|\}\}|\{(\d+)\}/g, (m, i?: string) =>
      i === undefined ? m[0] : String(args[Number(i)])
    );
  return new Function(
    'github',
    'vars',
    'inputs',
    'endsWith',
    'fromJSON',
    'format',
    `return (${body});`
  )(ctx.github, ctx.vars, ctx.inputs ?? {}, endsWith, JSON.parse, format) as string;
}

type Service = { image?: unknown; credentials?: unknown };

// The condition part of a gate: what decides civitai-dc, without the two runner labels.
const conditionOf = (runsOn: string) =>
  runsOn.replace(/^\$\{\{ /, '').replace(/ && 'civitai-dc' \|\| '[^']+' \}\}$/, '');
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The one shape a civitai-dc service may log in with: the whole credentials mapping switches on the
// runs-on condition, to the job's own github.token on civitai-dc and to an empty mapping (no login)
// elsewhere. Not a username and password each switching to '': the workflow schema types both as
// non-empty strings and fails the job at setup when one evaluates empty.
const credentialsOn = (cond: string) =>
  `\${{ ${cond} && fromJSON(format('{{"username":"{0}","password":"{1}"}}', github.actor, github.token)) || fromJSON('{}') }}`;

// What a civitai-dc job may not carry. Its one allowed token is its own read-only github.token,
// in a service's credentials for the private ghcr mirror, on exactly the condition that sends the
// job to civitai-dc: a hosted run (a fork PR, a bot) gets no credentials and Docker Hub's copy of
// the same digest, so a fork's token never meets the private package.
function tokenViolations(job: Job, runsOn: string): string[] {
  const cond = conditionOf(runsOn);
  const found: string[] = [];
  if (JSON.stringify(job.permissions ?? {}).includes('write')) found.push('write permission');
  const scrubbed = structuredClone(job);
  for (const [name, svc] of Object.entries(scrubbed.services ?? {})) {
    if (svc.credentials === undefined) continue;
    if ((job.permissions as Record<string, string> | undefined)?.packages !== 'read')
      found.push(`${name}: credentials without packages: read`);
    if (svc.credentials !== credentialsOn(cond)) {
      found.push(`${name}: credentials do not switch as a whole on the runs-on condition`);
      continue;
    }
    const image = new RegExp(
      `^\\$\\{\\{ ${escapeRegExp(
        cond
      )} && 'ghcr\\.io/civitai/[\\w.-]+:[\\w.-]+@(sha256:[0-9a-f]{64})' \\|\\| '[\\w./-]+:[\\w.-]+@(sha256:[0-9a-f]{64})' \\}\\}$`
    ).exec(String(svc.image));
    if (!image || image[1] !== image[2])
      found.push(`${name}: image not ghcr on the runs-on condition, else Docker Hub, same digest`);
    delete svc.credentials;
  }
  if (/secrets\.|github\.token/.test(JSON.stringify(scrubbed))) found.push('token or secret');
  return found;
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
    ({ job, runsOn, workflowPermissions }) => {
      expect(workflowPermissions).toBeDefined();
      expect(JSON.stringify(workflowPermissions)).not.toMatch(/write/);
      expect(tokenViolations(job, runsOn as string)).toEqual([]);
    }
  );

  it('logs in to a registry only from a civitai-dc job', () => {
    const civitaiDc = new Set(selfHostedJobs.map((j) => `${j.file} → ${j.name}`));
    const loggingIn = workflows.flatMap(({ file, doc }) =>
      Object.entries(doc.jobs ?? {})
        .filter(([, job]) => Object.values(job.services ?? {}).some((s) => s.credentials))
        .map(([name]) => `${file} → ${name}`)
    );
    expect(loggingIn).toContain('lint.yml → unit');
    expect(loggingIn.filter((job) => !civitaiDc.has(job))).toEqual([]);
  });

  const unit = selfHostedJobs.find((j) => j.file === 'lint.yml' && j.name === 'unit');
  const unitJob = unit?.job as Job;
  const unitRunsOn = unit?.runsOn as string;

  // The runner logs in to ghcr.io with the job's token by itself for any ghcr.io service or
  // container image that has no credentials, so a hosted job must not name one at all.
  it('pulls a ghcr.io image only from a civitai-dc job', () => {
    const civitaiDc = new Set(selfHostedJobs.map((j) => `${j.file} → ${j.name}`));
    const hostedGhcr = workflows.flatMap(({ file, doc }) =>
      Object.entries(doc.jobs ?? {})
        .filter(([name]) => !civitaiDc.has(`${file} → ${name}`))
        .filter(([, job]) =>
          JSON.stringify([(job as { container?: unknown }).container, job.services]).includes(
            'ghcr.io'
          )
        )
        .map(([name]) => `${file} → ${name}`)
    );
    expect(hostedGhcr).toEqual([]);
  });

  it('lint.yml unit pulls both services from the ghcr mirror on civitai-dc', () => {
    expect(Object.values(unitJob.services ?? {}).filter((s) => s.credentials)).toHaveLength(2);
  });

  it('unit-verify re-runs on the images unit pulls on hosted runners', () => {
    const verify = workflows.find((w) => w.file === 'lint.yml')?.doc.jobs?.['unit-verify'] as Job;
    const fallbacks = Object.fromEntries(
      Object.entries(unitJob.services ?? {}).map(([name, s]) => [
        name,
        /\|\| '([^']+)' \}\}$/.exec(String(s.image))?.[1],
      ])
    );
    expect(
      Object.fromEntries(Object.entries(verify.services ?? {}).map(([n, s]) => [n, s.image]))
    ).toEqual(fallbacks);
  });

  const redis = (j: Job) => j.services!.redis;
  const dcCond = () => conditionOf(unitRunsOn);
  // Each mutant is one way a future edit could hand the token to a hosted run or a broader one, or
  // fail every hosted run at setup.
  const mutants: Array<[string, (job: Job) => void]> = [
    [
      'unconditional credentials',
      (j) =>
        (redis(
          j
        ).credentials = `\${{ fromJSON(format('{{"username":"{0}","password":"{1}"}}', github.actor, github.token)) }}`),
    ],
    [
      'credentials whose condition drops the kill switch',
      (j) =>
        (redis(j).credentials = credentialsOn(
          dcCond().replace(/vars\.CIVITAI_DC_OFF != 'true' \|\| /, '')
        )),
    ],
    [
      'secrets.GITHUB_TOKEN in place of github.token',
      (j) =>
        (redis(j).credentials = credentialsOn(dcCond()).replace(
          'github.token',
          'secrets.GITHUB_TOKEN'
        )),
    ],
    [
      'a username and password that evaluate to empty strings on hosted runs',
      (j) =>
        (redis(j).credentials = {
          username: `\${{ ${dcCond()} && github.actor || '' }}`,
          password: `\${{ ${dcCond()} && github.token || '' }}`,
        }),
    ],
    ['the token in the job env', (j) => (j.env = { ...j.env, GH_TOKEN: '${{ github.token }}' })],
    ['packages: write', (j) => (j.permissions = { contents: 'read', packages: 'write' })],
    ['no packages: read', (j) => (j.permissions = { contents: 'read' })],
    [
      'an unconditional ghcr image',
      (j) => (redis(j).image = String(redis(j).image).replace(/^.* && '(ghcr[^']+)'.*$/, '$1')),
    ],
    [
      'a ghcr image pinned by tag only',
      (j) =>
        (redis(j).image = String(redis(j).image).replace(/@sha256:[0-9a-f]{64}(?=' \|\|)/, '')),
    ],
    [
      'a Docker Hub fallback on another digest',
      (j) =>
        (redis(j).image = String(redis(j).image).replace(
          /[0-9a-f]{64}(?=' \}\}$)/,
          '0'.repeat(64)
        )),
    ],
  ];

  it.each(mutants)('rejects %s', (_label, mutate) => {
    const job = structuredClone(unitJob);
    mutate(job);
    expect(JSON.stringify(job)).not.toBe(JSON.stringify(unitJob));
    expect(tokenViolations(job, unitRunsOn)).not.toEqual([]);
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

  // The runner, the registry and the credentials are decided together for every case above, and
  // no credential field ever evaluates empty (the workflow schema fails the job at setup if one does).
  it.each([
    ...cases.map((c) => [...c, {}] as const),
    ...overrideCases.map((c) => [...c, { runner: 'dc' }] as const),
  ])(
    'unit: %s pulls from the registry its runner can reach',
    (_label, github, vars, expected, inputs) => {
      const ctx = {
        github: { actor: 'someone', ...(github as object), token: 'TOKEN' },
        vars,
        inputs,
      };
      const onDc = evaluate(unitRunsOn, ctx) === SELF_HOSTED;
      expect(onDc).toBe(expected === SELF_HOSTED);
      for (const svc of Object.values(unitJob.services ?? {})) {
        expect(String(evaluate(String(svc.image), ctx)).startsWith('ghcr.io/civitai/')).toBe(onDc);
        const credentials =
          typeof svc.credentials === 'string'
            ? (evaluate(svc.credentials, ctx) as unknown as Record<string, unknown>)
            : Object.fromEntries(
                Object.entries(svc.credentials as Record<string, string>).map(([k, v]) => [
                  k,
                  evaluate(v, ctx),
                ])
              );
        for (const value of Object.values(credentials)) expect(value).toMatch(/./);
        expect(credentials).toEqual(onDc ? { username: ctx.github.actor, password: 'TOKEN' } : {});
      }
    }
  );
});
