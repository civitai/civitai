import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// `tRPC server parity` (.github/workflows/trpc-server-parity.yml) starts its preview-image run on
// `deployment_status`, never on `status`.
//
// `status` cannot be filtered at the trigger, so with it EVERY commit status in the repository
// started a run, nearly all skipped, and the workflow's own `tRPC parity` statuses started more
// (measurements: the PR that made this change). The preview pipeline now creates a Deployment in
// environment `preview`, straight in `success`, when it marks the commit `preview / deploy` =
// success; the gate job starts a runner for exactly that and nothing else.
//
// Pinned as whole normalised strings: a clause rewritten in another shape is a change someone
// has to make on purpose here, not one that passes a partial match.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '../../.github/workflows/trpc-server-parity.yml');
const text = readFileSync(FILE, 'utf8');

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
};
type Job = { if?: string; permissions?: Record<string, string>; steps?: Step[] };
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, Job>;
};
const wf = parse(text) as Workflow;
const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const DEPLOY_OK =
  "github.event.deployment.environment == 'preview' && github.event.deployment_status.state == 'success'";

describe('trpc-server-parity trigger', () => {
  it('listens to deployment_status (unfiltered: GitHub allows no types), never to status', () => {
    expect(Object.keys(wf.on).sort()).toEqual([
      'deployment_status',
      'pull_request',
      'workflow_dispatch',
    ]);
    expect(wf.on.deployment_status).toBeNull();
    expect(wf.on).not.toHaveProperty('status');
  });

  it('the gate job starts a runner for a preview deployment success, a non-draft PR, or a dispatch', () => {
    expect(norm(wf.jobs.gate.if)).toBe(
      "(github.event_name == 'pull_request' && !github.event.pull_request.draft) " +
        "|| github.event_name == 'workflow_dispatch' " +
        `|| (github.event_name == 'deployment_status' && ${DEPLOY_OK})`
    );
    expect(norm(wf.jobs.parity.if)).toBe("needs.gate.outputs.run == 'true'");
  });

  it('a preview deployment success is keyed on its commit; every other deployment on its own run', () => {
    expect(norm(wf.concurrency.group)).toBe(
      'trpc-server-parity-${{ ' +
        "github.event_name == 'deployment_status' && ( " +
        `(${DEPLOY_OK}) ` +
        "&& format('deployment-{0}', github.event.deployment.sha) " +
        "|| format('ignored-{0}', github.run_id) ) " +
        "|| format('{0}-{1}', github.ref, inputs.image) }}"
    );
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
  });

  it('a deployment run tests and checks out the deployed commit, and resolves its PR', () => {
    const scope = wf.jobs.gate.steps?.find((s) => s.id === 'scope');
    expect(scope?.env?.EVENT).toBe('${{ github.event_name }}');
    expect(scope?.env?.SHA).toBe('${{ github.event.deployment.sha || github.sha }}');
    expect(scope?.run).toContain('if [ "$EVENT" = deployment_status ]; then');
    const checkout = wf.jobs.parity.steps?.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe(
      "${{ github.event_name == 'deployment_status' && needs.gate.outputs.sha || '' }}"
    );
    // no expression anywhere still branches on the old event
    expect(text).not.toMatch(/event_name\s*==\s*'status'/);
    expect(text).not.toMatch(/"\$EVENT" = status\b/);
  });

  // A deployment run uses the DEPLOYED commit's copy of this file, so these pins are about the
  // file a merged change ships, not a ceiling a branch could not raise: the boundary is the
  // preview pipeline creating Deployments only for same-repository branches (the file header).
  it('token permissions stay minimal, and the workflow reads no repository secret', () => {
    expect(wf.permissions).toEqual({ contents: 'read', packages: 'read' });
    expect(wf.jobs.gate.permissions).toBeUndefined();
    expect(wf.jobs.parity.permissions).toEqual({
      contents: 'read',
      packages: 'read',
      statuses: 'write',
    });
    expect(text).not.toMatch(/secrets\./);
  });
});
