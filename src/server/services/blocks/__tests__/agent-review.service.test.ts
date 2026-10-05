import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P1) — provisioning service.
 *
 * Covers startAgentReview end-to-end against mocked DB / S3 / k8s:
 *   - ZIP path presigns the canonical bundleKey (no Forgejo reconstruct)
 *   - PUSH path (bundleKey==='') reconstructs from Forgejo, STAGES it, presigns
 *     the staged key
 *   - prior-report lookup → base64 PRIOR_REPORT_JSON_B64 + priorReportId (empty
 *     when there is no prior)
 *   - the running report row is inserted with appBlockId (XOR oauthClientId)
 *   - the provisioning Job carries EXACTLY the contract env vars
 *   - idempotent pre-delete of the same-name apply Job before POST
 *   - first-version (no app key) + non-pending → fail closed
 *   - a provisioning failure flips the row to `failed`
 * Plus deleteAgentReviewResources selector shape + buildAgentReviewApplyScript.
 */

const {
  mockEnv,
  mockFindUnique,
  mockAppBlockFindFirst,
  mockReportFindFirst,
  mockCreate,
  mockUpdateMany,
  mockPresign,
  mockStage,
  mockReconstruct,
  mockGetPrior,
  mockGetLatest,
  mockSign,
  mockDeriveHooks,
} = vi.hoisted(() => ({
  mockEnv: {
    APPS_KUBE_NAMESPACE: 'civitai-apps',
    APPS_DOMAIN: 'civit.ai',
    AGENT_REVIEW_COST_CAP_USD: '2',
    NEXTAUTH_URL: 'https://civitai.com',
    AGENT_REVIEW_CALLBACK_BASE_URL: undefined,
  } as Record<string, unknown>,
  mockFindUnique: vi.fn(),
  mockAppBlockFindFirst: vi.fn(async () => null as { id: string } | null),
  // Double-provision pre-check: no running report by default.
  mockReportFindFirst: vi.fn(async () => null as { id: string } | null),
  mockCreate: vi.fn(async () => undefined),
  mockUpdateMany: vi.fn(async () => ({ count: 1 })),
  mockPresign: vi.fn(async () => 'https://minio.internal/presigned?sig=x'),
  mockStage: vi.fn(async () => undefined),
  mockReconstruct: vi.fn(async () => Buffer.from('ZIPBYTES')),
  mockGetPrior: vi.fn(async () => null as { id: string; version: string } | null),
  // The TARGETED-RE-RUN carry-forward reads the latest report for this request.
  mockGetLatest: vi.fn(async () => null as Record<string, unknown> | null),
  mockSign: vi.fn(() => 'callback.token'),
  mockDeriveHooks: vi.fn(() => 'hooks.token'),
}));

vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => 'in-pod-token') }));
vi.mock('~/server/db/client', () => ({
  dbRead: {
    appBlockPublishRequest: { findUnique: mockFindUnique },
    appBlock: { findFirst: mockAppBlockFindFirst },
    appReviewAgentReport: { findFirst: mockReportFindFirst },
  },
  dbWrite: {
    appReviewAgentReport: { create: mockCreate, updateMany: mockUpdateMany },
  },
}));
vi.mock('~/utils/bundle-s3', () => ({
  presignBundleGet: mockPresign,
  stageBundleObject: mockStage,
  agentReviewBundleKey: (id: string, sha: string) => `agent-review/${id}-${sha}.zip`,
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  reconstructBundleFromForgejo: mockReconstruct,
}));
vi.mock('~/server/services/blocks/app-review-report.service', () => ({
  getPriorAgentReport: mockGetPrior,
  getAgentReport: mockGetLatest,
}));
vi.mock('~/server/services/blocks/review-session', () => ({
  signAgentCallbackToken: mockSign,
  deriveAgentHooksToken: mockDeriveHooks,
}));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppReviewAgentReportId: () => 'arar_TEST',
}));

import {
  startAgentReview,
  deleteAgentReviewResources,
  buildAgentReviewApplyScript,
  agentReviewName,
} from '~/server/services/blocks/agent-review.service';

const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';
const SHA = 'f'.repeat(64);

type Call = { url: string; method: string; body: any };
let calls: Call[] = [];

function stubFetch(postOk = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (init.method === 'POST') {
        if (!postOk) {
          return {
            ok: false,
            status: 500,
            statusText: 'err',
            text: async () => 'boom',
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 201,
          statusText: 'Created',
          text: async () => JSON.stringify({ metadata: { name: 'agent-apply-job' } }),
        } as unknown as Response;
      }
      if (init.method === 'GET' || init.method === undefined) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ items: [{ metadata: { name: 'review-agent-abc' } }] }),
        } as unknown as Response;
      }
      // DELETE (pre-delete / teardown)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '',
      } as unknown as Response;
    })
  );
}

beforeEach(() => {
  calls = [];
  process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
  process.env.KUBERNETES_SERVICE_PORT = '443';
  process.env.NEXTAUTH_URL = 'https://civitai.com';
  vi.clearAllMocks();
  mockAppBlockFindFirst.mockResolvedValue(null);
  mockReportFindFirst.mockResolvedValue(null);
  mockGetPrior.mockResolvedValue(null);
  mockGetLatest.mockResolvedValue(null);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockEnv.NEXTAUTH_URL = 'https://civitai.com';
  mockEnv.AGENT_REVIEW_CALLBACK_BASE_URL = undefined;
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

const pendingRequest = (over: Record<string, unknown> = {}) => ({
  id: PUBREQ,
  slug: 'my-app',
  version: '0.2.0',
  bundleKey: `bundles/${SHA}.zip`,
  bundleSha256: SHA,
  appBlockId: 'ab_existing',
  forgejoCommitSha: null,
  status: 'pending',
  ...over,
});

function postedJob() {
  const post = calls.find((c) => c.method === 'POST');
  expect(post).toBeDefined();
  return post!.body;
}
/**
 * The `data` of the single `appReviewAgentReport.create` this run performed.
 *
 * ⚠️ One CAST in one place. `mockCreate` is `vi.fn(async () => undefined)`, so TypeScript
 * infers its `mock.calls` as the empty tuple `[]` and every direct
 * `mockCreate.mock.calls[0][0].data` is two type errors (TS2532 + TS2493). The older
 * assertions in this file each carry their own pair; new ones go through here instead so
 * `scripts/ci/typecheck-tests-gate.mjs` does not get worse. The `length` check is what makes
 * the cast honest: an absent call fails loudly rather than reading `undefined.data`.
 */
function createdRow(): Record<string, unknown> {
  const calls = mockCreate.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
  // 🔴 EXACTLY ONE, not "at least one". A DOUBLED insert is the plausible defect of a
  // carry-forward that reads-then-writes, and `calls[0]` would report the first of two
  // perfectly happily.
  expect(calls, 'exactly one report row was created').toHaveLength(1);
  return calls[0][0].data;
}

function jobEnv() {
  const env = postedJob().spec.template.spec.containers[0].env as Array<{
    name: string;
    value: string;
  }>;
  return Object.fromEntries(env.map((e) => [e.name, e.value]));
}

describe('startAgentReview — ZIP path', () => {
  it('presigns the canonical bundleKey, inserts a running row, provisions the Job', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest());

    const res = await startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 });

    expect(res).toEqual({ reportId: 'arar_TEST', agentName: agentReviewName(PUBREQ) });

    // Presigned the canonical bundle key — no Forgejo reconstruct/stage.
    expect(mockPresign).toHaveBeenCalledWith(`bundles/${SHA}.zip`, expect.any(Number));
    expect(mockReconstruct).not.toHaveBeenCalled();
    expect(mockStage).not.toHaveBeenCalled();

    // Running row keyed on the stable slug (+ kind='onsite'); appBlockId is
    // informational (resolved here), oauthClientId left null (out of P1 scope).
    const created = mockCreate.mock.calls[0][0].data;
    expect(created).toMatchObject({
      id: 'arar_TEST',
      publishRequestId: PUBREQ,
      slug: 'my-app',
      kind: 'onsite',
      appBlockId: 'ab_existing',
      version: '0.2.0',
      bundleSha256: SHA,
      status: 'running',
      priorReportId: null,
    });
    expect(created.oauthClientId).toBeUndefined();

    // Job carries EXACTLY the contract env vars.
    const e = jobEnv();
    expect(e).toEqual({
      AGENT_NAME: agentReviewName(PUBREQ),
      PUBLISH_REQUEST_ID: PUBREQ,
      APP_SLUG: 'my-app',
      BUNDLE_PRESIGNED_URL: 'https://minio.internal/presigned?sig=x',
      CALLBACK_URL: 'https://civitai.com/api/internal/blocks/agent-report-callback',
      CALLBACK_TOKEN: 'callback.token',
      PRIOR_REPORT_JSON_B64: '',
      COST_CAP_USD: '2',
      HOOKS_TOKEN: 'hooks.token',
    });

    // Job metadata labels for teardown selection.
    expect(postedJob().metadata.labels['civitai.com/publish-request-id']).toBe(PUBREQ);
  });

  it('pre-deletes the same-name apply Job before POST (idempotency)', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest());
    await startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 });

    const jobName = `${agentReviewName(PUBREQ)}-apply`;
    const del = calls.find((c) => c.method === 'DELETE' && c.url.includes(`/jobs/${jobName}`));
    const post = calls.find((c) => c.method === 'POST');
    expect(del).toBeDefined();
    expect(post).toBeDefined();
    // pre-delete precedes the create.
    expect(calls.indexOf(del!)).toBeLessThan(calls.indexOf(post!));
  });
});

describe('startAgentReview — PUSH (Forgejo) path', () => {
  it('reconstructs from Forgejo, stages it, and presigns the staged key', async () => {
    mockFindUnique.mockResolvedValue(
      pendingRequest({ bundleKey: '', forgejoCommitSha: 'c'.repeat(40), appBlockId: 'ab_x' })
    );

    await startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 });

    expect(mockReconstruct).toHaveBeenCalledWith('my-app', 'c'.repeat(40));
    const stagedKey = `agent-review/${PUBREQ}-${SHA}.zip`;
    expect(mockStage).toHaveBeenCalledWith(stagedKey, expect.any(Buffer));
    expect(mockPresign).toHaveBeenCalledWith(stagedKey, expect.any(Number));
  });
});

describe('startAgentReview — prior report', () => {
  it('base64s the prior report JSON and links priorReportId', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest());
    const prior = { id: 'arar_prior', version: '0.1.0' };
    mockGetPrior.mockResolvedValue(prior);

    await startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 });

    const expectedB64 = Buffer.from(JSON.stringify(prior)).toString('base64');
    expect(jobEnv().PRIOR_REPORT_JSON_B64).toBe(expectedB64);
    expect(mockCreate.mock.calls[0][0].data.priorReportId).toBe('arar_prior');
    expect(mockGetPrior).toHaveBeenCalledWith({ slug: 'my-app', version: '0.2.0' });
  });
});

describe('startAgentReview — app-key resolution', () => {
  it('falls back to the AppBlock by slug when the request has no appBlockId', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest({ appBlockId: null }));
    mockAppBlockFindFirst.mockResolvedValue({ id: 'ab_by_slug' });

    await startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 });
    expect(mockCreate.mock.calls[0][0].data.appBlockId).toBe('ab_by_slug');
  });

  it('first-version review (no appBlockId, no AppBlock) PERSISTS keyed by slug, appBlockId null', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest({ appBlockId: null }));
    mockAppBlockFindFirst.mockResolvedValue(null);

    const res = await startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 });
    expect(res).toEqual({ reportId: 'arar_TEST', agentName: agentReviewName(PUBREQ) });

    const created = mockCreate.mock.calls[0][0].data;
    expect(created).toMatchObject({ slug: 'my-app', kind: 'onsite', appBlockId: null });
    // Prior lookup + provisioning both proceed keyed by slug — no first-version throw.
    expect(mockGetPrior).toHaveBeenCalledWith({ slug: 'my-app', version: '0.2.0' });
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
  });

  it('rejects a non-pending request', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest({ status: 'approved' }));
    await expect(startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 })).rejects.toThrow(
      /not pending/i
    );
  });

  it('rejects a missing request', async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 })).rejects.toThrow(
      /not found/i
    );
  });
});

describe('startAgentReview — double-provision guard (audit #3)', () => {
  it('refuses a second dispatch while a review is already running for the request', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest());
    mockReportFindFirst.mockResolvedValue({ id: 'arar_running' });

    await expect(startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 })).rejects.toThrow(
      /already running/i
    );
    // No new row inserted, no Job provisioned.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(mockReportFindFirst).toHaveBeenCalledWith({
      where: { publishRequestId: PUBREQ, status: 'running' },
      select: { id: true },
    });
  });
});

describe('startAgentReview — callback base URL (containment)', () => {
  it('defaults CALLBACK_URL to NEXTAUTH_URL when AGENT_REVIEW_CALLBACK_BASE_URL is unset', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest());
    await startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 });
    expect(jobEnv().CALLBACK_URL).toBe(
      'https://civitai.com/api/internal/blocks/agent-report-callback'
    );
  });

  it('prefers the in-cluster AGENT_REVIEW_CALLBACK_BASE_URL when set (keeps report off the public internet)', async () => {
    mockEnv.AGENT_REVIEW_CALLBACK_BASE_URL = 'http://web.internal.svc.cluster.local/';
    mockFindUnique.mockResolvedValue(pendingRequest());
    await startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 });
    expect(jobEnv().CALLBACK_URL).toBe(
      'http://web.internal.svc.cluster.local/api/internal/blocks/agent-report-callback'
    );
  });
});

describe('startAgentReview — provisioning failure', () => {
  it('flips the running row to failed when the Job POST fails', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest());
    stubFetch(false); // POST returns non-ok → unwrap throws

    await expect(startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 })).rejects.toThrow();

    // Row was inserted running, then flipped to failed.
    expect(mockCreate).toHaveBeenCalled();
    const upd = mockUpdateMany.mock.calls.at(-1)![0];
    expect(upd.where).toMatchObject({ id: 'arar_TEST', status: 'running' });
    expect(upd.data.status).toBe('failed');
  });
});

describe('deleteAgentReviewResources', () => {
  it('LISTs jobs + (legacy) deployments + services by the review-agent selector then DELETEs by name', async () => {
    await deleteAgentReviewResources({ slug: 'my-app', publishRequestId: PUBREQ });

    const lists = calls.filter((c) => c.method === 'GET');
    expect(lists.length).toBe(3);
    for (const l of lists) {
      expect(decodeURIComponent(l.url)).toContain(
        `civitai.com/role=review-agent,civitai.com/publish-request-id=${PUBREQ}`
      );
    }
    // The current workload is a Job; deployments/services remain as legacy sweeps.
    expect(lists.some((l) => l.url.includes('/jobs?'))).toBe(true);
    expect(lists.some((l) => l.url.includes('/deployments?'))).toBe(true);
    expect(lists.some((l) => l.url.includes('/services?'))).toBe(true);

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes.length).toBe(3);
    for (const d of deletes) {
      expect(d.url).toContain('/review-agent-abc');
      expect(d.url).not.toContain('labelSelector');
    }
  });

  it('never throws when k8s is down (best-effort)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('k8s down');
      })
    );
    await expect(
      deleteAgentReviewResources({ slug: 'my-app', publishRequestId: PUBREQ })
    ).resolves.toBeUndefined();
  });
});

describe('buildAgentReviewApplyScript', () => {
  it('renders the review-agent template, applies it, and does NOT cat secrets', () => {
    const script = buildAgentReviewApplyScript('civitai-apps');
    expect(script).toContain('/templates/review-agent.yaml.tmpl');
    expect(script).toContain('kubectl apply -f /tmp/rendered.yaml');
    // Idempotent re-dispatch: a same-name review-agent Job (immutable spec) is
    // deleted before apply recreates it.
    expect(script).toContain(
      'kubectl delete job "${AGENT_NAME}" -n civitai-apps --ignore-not-found'
    );
    // The rendered manifest embeds the presigned URL + callback token — never cat
    // it (match an actual `cat` command line, not the "Do NOT cat" comment).
    expect(script).not.toContain('\ncat /tmp/rendered.yaml');
    // envsubst fallback covers every contract var.
    for (const v of [
      'AGENT_NAME',
      'PUBLISH_REQUEST_ID',
      'APP_SLUG',
      'BUNDLE_PRESIGNED_URL',
      'CALLBACK_URL',
      'CALLBACK_TOKEN',
      'PRIOR_REPORT_JSON_B64',
      'COST_CAP_USD',
      'HOOKS_TOKEN',
    ]) {
      expect(script).toContain(v);
    }
  });
});

describe('agentReviewName', () => {
  it('is DNS-label-safe and ≤63 chars', () => {
    const name = agentReviewName(PUBREQ);
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(agentReviewName(PUBREQ)).toBe(name); // deterministic
  });
});

/**
 * TARGETED RE-RUN — retry ONE failed analysis instead of all three.
 *
 * 🔴 WHY THIS EXISTS. The runner marks the whole report `failed` when any one sub-analysis
 * fails, so a moderator's only affordance was "Run again", which re-bills all three
 * analyses (~$0.06–0.18 a run). A targeted retry needs two things to be true on this side,
 * and both are asserted below: the section list reaches the Job as a contract var, and the
 * surviving sections are CARRIED FORWARD onto the new row so the retry cannot destroy the
 * analyses the mod was keeping.
 */
describe('startAgentReview — targeted re-run', () => {
  /** A prior report with two good sections and one broken one — the live failure shape. */
  const latestPartial = {
    id: 'arar_PREV',
    model: 'some/model',
    scopeVerdicts: { scopes: [{ declared: 'models:read:self' }], overBroad: [] },
    securityAudit: { findings: [{ severity: 'low' }], manifestUnexpectedKeys: [] },
    codeReview: { error: 'non-json-response' },
  } as Record<string, unknown>;

  it('passes the section list to the Job as AGENT_REVIEW_SECTIONS', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest());
    mockGetLatest.mockResolvedValue(latestPartial);

    await startAgentReview({
      publishRequestId: PUBREQ,
      modUserId: 7,
      sections: ['codeReview'],
    });

    expect(jobEnv().AGENT_REVIEW_SECTIONS).toBe('codeReview');
  });

  it('🔴 CARRIES FORWARD the sections it is NOT re-running, so a retry cannot lose them', () => {
    // A re-run inserts a NEW row and `getAgentReport` returns the most recently started
    // one — so without this, retrying the code review would replace a report holding two
    // good sections with a report holding one, which is strictly worse than not retrying.
    mockFindUnique.mockResolvedValue(pendingRequest());
    mockGetLatest.mockResolvedValue(latestPartial);

    return startAgentReview({
      publishRequestId: PUBREQ,
      modUserId: 7,
      sections: ['codeReview'],
    }).then(() => {
      const created = createdRow();
      expect(created.scopeVerdicts).toEqual(latestPartial.scopeVerdicts);
      expect(created.securityAudit).toEqual(latestPartial.securityAudit);
      expect(created.model).toBe('some/model');
      // 🔴 AND THE FAILED ONE IS **NOT** SEEDED. Carrying an `{ error }` forward would
      // re-report the OLD failure as if it were this run's, and the panel would show a
      // failure for an analysis that is currently running.
      expect(created.codeReview).toBeUndefined();
      // The row is still a fresh `running` row with its own id.
      expect(created.id).toBe('arar_TEST');
      expect(created.status).toBe('running');
    });
  });

  it('a section that previously failed is not carried even when it is NOT the one being retried', async () => {
    // Retry the SCOPES analysis on a report whose CODE review had failed: scopes is
    // excluded because it is being re-run, and codeReview because it is a failure marker —
    // so only the security audit survives.
    mockFindUnique.mockResolvedValue(pendingRequest());
    mockGetLatest.mockResolvedValue(latestPartial);

    await startAgentReview({
      publishRequestId: PUBREQ,
      modUserId: 7,
      sections: ['scopeVerdicts'],
    });

    const created = createdRow();
    expect(created.securityAudit).toEqual(latestPartial.securityAudit);
    expect(created.scopeVerdicts).toBeUndefined();
    expect(created.codeReview).toBeUndefined();
  });

  it('with no prior report there is nothing to carry, and it still dispatches', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest());
    mockGetLatest.mockResolvedValue(null);

    await startAgentReview({
      publishRequestId: PUBREQ,
      modUserId: 7,
      sections: ['codeReview'],
    });

    const created = createdRow();
    expect(created.scopeVerdicts).toBeUndefined();
    expect(created.securityAudit).toBeUndefined();
    expect(jobEnv().AGENT_REVIEW_SECTIONS).toBe('codeReview');
  });

  it('🔴 NEGATIVE CONTROL — a FULL run sets NO section var and carries NOTHING', async () => {
    // Without this the assertions above are satisfied by a service that always stamps the
    // var and always seeds, which would change every existing dispatch.
    mockFindUnique.mockResolvedValue(pendingRequest());
    mockGetLatest.mockResolvedValue(latestPartial);

    await startAgentReview({ publishRequestId: PUBREQ, modUserId: 7 });

    expect(jobEnv().AGENT_REVIEW_SECTIONS).toBeUndefined();
    const created = createdRow();
    expect(created.scopeVerdicts).toBeUndefined();
    expect(created.securityAudit).toBeUndefined();
    // …and the latest report is not even consulted on the full path.
    expect(mockGetLatest).not.toHaveBeenCalled();
  });

  it('🔴 naming ALL THREE sections is a FULL run, not a targeted one', async () => {
    // An exhaustive selection has nothing to carry forward, so taking the targeted path
    // would seed nothing while still stamping a var that tells the runner to do everything
    // — i.e. a second spelling of the default with an extra moving part.
    mockFindUnique.mockResolvedValue(pendingRequest());
    mockGetLatest.mockResolvedValue(latestPartial);

    await startAgentReview({
      publishRequestId: PUBREQ,
      modUserId: 7,
      sections: ['scopeVerdicts', 'securityAudit', 'codeReview'],
    });

    expect(jobEnv().AGENT_REVIEW_SECTIONS).toBeUndefined();
    expect(mockGetLatest).not.toHaveBeenCalled();
  });

  it('a duplicated section is deduped rather than stamping it twice', async () => {
    mockFindUnique.mockResolvedValue(pendingRequest());
    mockGetLatest.mockResolvedValue(latestPartial);

    await startAgentReview({
      publishRequestId: PUBREQ,
      modUserId: 7,
      sections: ['codeReview', 'codeReview'],
    });

    expect(jobEnv().AGENT_REVIEW_SECTIONS).toBe('codeReview');
  });

  it('two sections join with a comma, in the ORDER GIVEN', async () => {
    // 🔴 THE ARGUMENT IS DELIBERATELY *NOT* IN DISPLAY ORDER. `['securityAudit','codeReview']`
    // renders identically under "preserve the caller's order" and under "sort into
    // AGENT_REVIEW_SECTIONS order", so it cannot separate the two hypotheses. Passing them
    // reversed relative to the ledger is what makes this assertion mean something.
    mockFindUnique.mockResolvedValue(pendingRequest());
    mockGetLatest.mockResolvedValue(latestPartial);

    await startAgentReview({
      publishRequestId: PUBREQ,
      modUserId: 7,
      sections: ['codeReview', 'securityAudit'],
    });

    expect(jobEnv().AGENT_REVIEW_SECTIONS).toBe('codeReview,securityAudit');
    // Only the untouched section is carried.
    const created = createdRow();
    expect(created.scopeVerdicts).toEqual(latestPartial.scopeVerdicts);
    expect(created.securityAudit).toBeUndefined();
  });
});
