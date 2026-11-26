import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * MOD REVIEW SANDBOX (#2831) — triggerApplyReview + deleteReviewResources
 * against a mocked in-pod k8s API. Asserts the review apply Job carries the
 * review labels + 24h TTL and renders the review host, and that
 * deleteReviewResources LISTS each resource type by the review label selector
 * then DELETEs each matched object BY NAME (the deletecollection-free shape
 * coordinated with the tightened talos RBAC).
 */

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    APPS_DOMAIN: 'civit.ai',
    APPS_KUBE_NAMESPACE: 'civitai-apps',
  } as Record<string, unknown>,
}));
vi.mock('~/env/server', () => ({ env: mockEnv }));

// The flags deleteReviewResources reads (`app-blocks-review-shared-server`); every other flag off.
const flags = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async (flag: string) => flags.on.has(flag)),
}));

// In-pod ServiceAccount token + cluster host (getDp1Target reads these).
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => 'in-pod-token'),
}));

import {
  triggerApplyReview,
  deleteReviewResources,
  LIVE_RESTORE_SCRIPT,
  LIVE_UNPUBLISH_SCRIPT,
  REVIEW_UNPUBLISH_SCRIPT,
  triggerLivePointerJob,
  parseReadinessProbeSlugs,
} from '~/server/services/blocks/apps-pipeline.service';

type Call = { url: string; method: string; body: unknown };

describe('triggerApplyReview / deleteReviewResources', () => {
  let calls: Call[] = [];

  beforeEach(() => {
    calls = [];
    flags.on.clear();
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    process.env.KUBERNETES_SERVICE_PORT = '443';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          method: String(init.method),
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        // POST create → return a metadata.name.
        if (init.method === 'POST') {
          return {
            ok: true,
            status: 201,
            statusText: 'Created',
            text: async () => JSON.stringify({ metadata: { name: 'review-apply-job' } }),
          } as unknown as Response;
        }
        // GET = the deleteReviewResources LIST call. Return one matched item per
        // resource type so the sweep issues a delete-by-name for it. (The apply
        // Job's pre-delete is a DELETE, not a GET, so it's unaffected.)
        if (init.method === 'GET' || init.method === undefined) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () =>
              JSON.stringify({ items: [{ metadata: { name: 'review-obj-1' } }] }),
          } as unknown as Response;
        }
        // DELETE → ok.
        return { ok: true, status: 200, statusText: 'OK', text: async () => '' } as unknown as Response;
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a review apply Job with review labels + 24h TTL', async () => {
    const res = await triggerApplyReview({
      slug: 'my-app',
      sha: 'a'.repeat(40),
      publishRequestId: 'pubreq_0123456789ABCDEFGHJKMNPQRS',
      imageRef: `ghcr.io/civitai/app-block-review-my-app:${'a'.repeat(40)}`,
    });
    expect(res.name).toBe('review-apply-job');

    const post = calls.find((c) => c.method === 'POST');
    expect(post).toBeDefined();
    const job = post!.body as any;
    expect(job.kind).toBe('Job');
    expect(job.spec.ttlSecondsAfterFinished).toBe(86400);
    expect(job.metadata.labels['civitai.com/review-mode']).toBe('true');
    expect(job.metadata.labels['civitai.com/publish-request-id']).toBe(
      'pubreq_0123456789ABCDEFGHJKMNPQRS'
    );
    // The apply script must reference the review template + the review host sha.
    const script = job.spec.template.spec.containers[0].args[0] as string;
    expect(script).toContain('/templates/review.yaml.tmpl');
    expect(script).toContain('REVIEW_HOST_SHA');
    // REVIEW_NAME must be EXPORTED — envsubst only substitutes exported vars, so
    // without `export` the manifest renders empty resource names and the apply
    // Job fails ("Middleware -mod-gate is invalid"). Regression guard.
    expect(script).toContain('export REVIEW_NAME=');
    // Image is passed through env.
    const envVars = job.spec.template.spec.containers[0].env as Array<{ name: string; value: string }>;
    expect(envVars.find((e) => e.name === 'IMAGE')!.value).toContain('app-block-review-my-app');
  });

  it('deleteReviewResources LISTs each resource type by the review label selector then DELETEs by name', async () => {
    await deleteReviewResources({
      slug: 'my-app',
      sha: 'a'.repeat(40),
      publishRequestId: 'pubreq_0123456789ABCDEFGHJKMNPQRS',
    });

    // LIST: one GET per resource type, each carrying the review label selector.
    const lists = calls.filter((c) => c.method === 'GET');
    // deployments, services, ingressroutes, middlewares
    expect(lists.length).toBe(4);
    for (const l of lists) {
      expect(decodeURIComponent(l.url)).toContain(
        'civitai.com/review-mode=true,civitai.com/publish-request-id=pubreq_0123456789ABCDEFGHJKMNPQRS'
      );
    }
    expect(lists.some((l) => l.url.includes('/deployments?'))).toBe(true);
    expect(lists.some((l) => l.url.includes('/services?'))).toBe(true);
    expect(lists.some((l) => l.url.includes('/ingressroutes?'))).toBe(true);
    expect(lists.some((l) => l.url.includes('/middlewares?'))).toBe(true);

    // DELETE: each matched object deleted BY NAME (no labelSelector → no
    // deletecollection). The mock returns one item per type → 4 deletes.
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(4);
    for (const d of deletes) {
      expect(d.url).toContain('/review-obj-1');
      // delete-by-name must NOT carry a labelSelector (that's the deletecollection
      // verb we dropped to tighten RBAC).
      expect(d.url).not.toContain('labelSelector');
    }
    expect(deletes.some((d) => d.url.includes('/deployments/review-obj-1'))).toBe(true);
    expect(deletes.some((d) => d.url.includes('/services/review-obj-1'))).toBe(true);
    expect(deletes.some((d) => d.url.includes('/ingressroutes/review-obj-1'))).toBe(true);
    expect(deletes.some((d) => d.url.includes('/middlewares/review-obj-1'))).toBe(true);
  });

  it('deleteReviewResources swallows errors (best-effort, never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('k8s down');
      })
    );
    await expect(
      deleteReviewResources({
        slug: 'my-app',
        sha: 'a'.repeat(40),
        publishRequestId: 'pubreq_0123456789ABCDEFGHJKMNPQRS',
      })
    ).resolves.toBeUndefined();
  });

  const SHA = 'a'.repeat(40);
  const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';
  const jobPosts = () =>
    calls.filter((c) => c.method === 'POST' && c.url.endsWith('/jobs')).map((c) => c.body as any);
  const scriptOf = (job: any) => job.spec.template.spec.containers[0].args[0] as string;
  /** The resource kinds the label sweep LISTed for this request, by the review label selector. */
  const sweptKinds = () =>
    calls
      .filter(
        (c) =>
          c.method === 'GET' &&
          decodeURIComponent(c.url).includes(
            `civitai.com/review-mode=true,civitai.com/publish-request-id=${PUBREQ}`
          )
      )
      .map((c) => /\/([a-z]+)\?labelSelector=/.exec(c.url)?.[1])
      .sort();
  const SWEPT_KINDS = ['deployments', 'ingressroutes', 'middlewares', 'services'];
  const envOf = (job: any) =>
    Object.fromEntries(
      (job.spec.template.spec.containers[0].env as Array<{ name: string; value: string }>).map(
        (e) => [e.name, e.value]
      )
    );

  it('shared server: the review apply Job publishes in the review lane and renders nothing', async () => {
    await triggerApplyReview({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
      imageRef: `ghcr.io/civitai/app-block-review-my-app:${SHA}`,
      sharedServer: true,
    });
    const script = scriptOf(jobPosts()[0]);
    expect(script).toContain('PUBLISH_LANE=review bash /templates/publish.sh');
    expect(script).not.toContain('review.yaml.tmpl');
    expect(script).not.toContain('kubectl apply');
    expect(script).not.toContain('rollout status');
  });

  it('CONTROL: without the flag the review apply Job renders and applies, and never publishes', async () => {
    await triggerApplyReview({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
      imageRef: `ghcr.io/civitai/app-block-review-my-app:${SHA}`,
    });
    const script = scriptOf(jobPosts()[0]);
    expect(script).toContain('kubectl apply -f /tmp/rendered.yaml');
    expect(script).not.toContain('publish.sh');
  });

  it('shared server ON: teardown runs the review unpublish Job for the preview host, then the sweep', async () => {
    flags.on.add('app-blocks-review-shared-server');
    await deleteReviewResources({ slug: 'my-app', sha: SHA, publishRequestId: PUBREQ });
    const jobs = jobPosts();
    expect(jobs).toHaveLength(1);
    expect(scriptOf(jobs[0])).toBe(REVIEW_UNPUBLISH_SCRIPT);
    expect(REVIEW_UNPUBLISH_SCRIPT).toContain('bash /templates/review-unpublish.sh');
    expect(jobs[0].metadata.name).toBe('my-app-review-unpub-aaaaaaaa');
    expect(jobs[0].spec.template.spec.serviceAccountName).toBe('apps-applier');
    expect(jobs[0].spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    expect(envOf(jobs[0])).toMatchObject({
      REVIEW_HOST_SHA: SHA.slice(0, 16),
      SHA,
      PUBLISH_REQUEST_ID: PUBREQ,
    });
    // The label sweep still runs (objects a pre-flag preview may still have).
    expect(sweptKinds()).toEqual(SWEPT_KINDS);
  });

  it('shared server OFF: teardown creates no Job (the sweep only, as before)', async () => {
    await deleteReviewResources({ slug: 'my-app', sha: SHA, publishRequestId: PUBREQ });
    expect(jobPosts()).toHaveLength(0);
  });

  it('shared server ON with no review sha: nothing to unpublish, the sweep still runs', async () => {
    flags.on.add('app-blocks-review-shared-server');
    await deleteReviewResources({ slug: 'my-app', sha: '', publishRequestId: PUBREQ });
    expect(jobPosts()).toHaveLength(0);
    expect(sweptKinds()).toEqual(SWEPT_KINDS);
  });

  it('live unpublish: a Job running the live unpublish script for the slug', async () => {
    await triggerLivePointerJob({ slug: 'my-app', action: 'unpublish' });
    const [job] = jobPosts();
    expect(scriptOf(job)).toBe(LIVE_UNPUBLISH_SCRIPT);
    expect(LIVE_UNPUBLISH_SCRIPT).toContain('bash /templates/live-unpublish.sh');
    expect(envOf(job)).toEqual({ SLUG: 'my-app' });
    expect(job.metadata.name).toBe('my-app-live-pointer');
  });

  // Takedown and restore share ONE Job name per app: starting either deletes the other in flight.
  it('live restore: the live-lane publish of the approved build, under the same Job name', async () => {
    await triggerLivePointerJob({
      slug: 'my-app',
      action: 'restore',
      sha: SHA,
      imageRef: `ghcr.io/civitai/app-block-my-app:${SHA}`,
    });
    const [job] = jobPosts();
    expect(scriptOf(job)).toBe(LIVE_RESTORE_SCRIPT);
    expect(LIVE_RESTORE_SCRIPT).toContain('PUBLISH_REQUIRED=1 bash /templates/publish.sh');
    expect(LIVE_RESTORE_SCRIPT).not.toContain('PUBLISH_LANE');
    expect(envOf(job)).toEqual({
      SLUG: 'my-app',
      SHA,
      IMAGE: `ghcr.io/civitai/app-block-my-app:${SHA}`,
    });
    expect(job.metadata.name).toBe('my-app-live-pointer');
    // The same-name Job is deleted before this one is created.
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toContain('/jobs/my-app-live-pointer');
  });

  // `apply-job` is the role the cluster grants the access both scripts need to start their pod
  // (the role every apply Job uses); any other role leaves the Job unable to do anything.
  it('the new Jobs run as role apply-job (Job and pod labels)', async () => {
    await deleteReviewResources({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
      sharedServer: true,
    });
    await triggerLivePointerJob({ slug: 'my-app', action: 'unpublish' });
    await triggerLivePointerJob({
      slug: 'my-app',
      action: 'restore',
      sha: SHA,
      imageRef: `ghcr.io/civitai/app-block-my-app:${SHA}`,
    });
    const jobs = jobPosts();
    expect(jobs.map((j) => j.metadata.name)).toEqual([
      'my-app-review-unpub-aaaaaaaa',
      'my-app-live-pointer',
      'my-app-live-pointer',
    ]);
    for (const job of jobs) {
      expect(job.metadata.labels['civitai.com/role']).toBe('apply-job');
      expect(job.spec.template.metadata.labels['civitai.com/role']).toBe('apply-job');
    }
  });

  it('teardown follows the RECORDED serving mode, not the current flag', async () => {
    // Built on the shared server, torn down after the flag went off: still unpublished.
    await deleteReviewResources({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
      sharedServer: true,
    });
    expect(jobPosts()).toHaveLength(1);
    // Built per-preview, torn down after the flag went on: no unpublish Job.
    calls = [];
    flags.on.add('app-blocks-review-shared-server');
    await deleteReviewResources({
      slug: 'my-app',
      sha: SHA,
      publishRequestId: PUBREQ,
      sharedServer: false,
    });
    expect(jobPosts()).toHaveLength(0);
    // Both still sweep the per-preview objects.
    expect(sweptKinds()).toEqual(SWEPT_KINDS);
  });

  it('parses the readiness-probe app list: one per line, comments and blanks ignored', () => {
    expect(parseReadinessProbeSlugs('# probe apps\nreadiness-probe-app\n\n  other-app  # x\n')).toEqual([
      'readiness-probe-app',
      'other-app',
    ]);
  });
});

