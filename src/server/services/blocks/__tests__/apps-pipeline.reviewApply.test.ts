import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// In-pod ServiceAccount token + cluster host (getDp1Target reads these).
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => 'in-pod-token'),
}));

import {
  triggerApplyReview,
  deleteReviewResources,
} from '~/server/services/blocks/apps-pipeline.service';

type Call = { url: string; method: string; body: unknown };

describe('triggerApplyReview / deleteReviewResources', () => {
  let calls: Call[] = [];

  beforeEach(() => {
    calls = [];
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
});
