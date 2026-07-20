import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import {
  getDp1Target,
  k8sFetch,
  unwrap,
} from '~/server/services/blocks/apps-pipeline.service';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P1) — provisioning lane.
 *
 * A moderator reviewing a PENDING publish request can dispatch an EPHEMERAL,
 * sandboxed review agent. This service is the civitai side of that:
 *   - `startAgentReview` gathers the reviewed bundle (presigned for in-cluster
 *     pull), the prior-version report, mints a per-review callback bearer, writes
 *     a `running` report row, and provisions a k8s apply Job that renders the
 *     already-shipped `review-agent.yaml.tmpl` (from the `app-templates`
 *     ConfigMap) via envsubst + `kubectl apply` — MIRRORING the review-sandbox
 *     apply lane (`triggerApplyReview`) exactly.
 *   - `deleteAgentReviewResources` tears the agent's k8s objects down by label
 *     selector (best-effort, idempotent, never throws) — called from the shared
 *     `teardownReviewForRequest` decision hook.
 *
 * DARK: `startAgentReview` is only reachable via a tRPC procedure gated on the
 * `app-blocks-agentic-review` Flipt flag, which does not exist yet → the whole
 * feature is inert on merge.
 *
 * Everything is a thin REST wrapper over the in-pod ServiceAccount k8s API (no
 * kubernetes-client dependency), reusing `k8sFetch`/`getDp1Target` from the
 * apps-pipeline service. Infra identifiers come from EXISTING env
 * (`env.APPS_KUBE_NAMESPACE`) — none are hardcoded here.
 */

/** Presigned-bundle TTL. The agent pod's init curls it once, shortly after the
 *  apply Job creates the Deployment; a few minutes covers image-pull + init. */
export const AGENT_REVIEW_BUNDLE_PRESIGN_TTL_SECONDS = 15 * 60;

/**
 * Derive the DNS-label-safe agent object name from a publishRequestId. Must be
 * ≤63 chars and match `[a-z0-9-]`. A short hex hash of the id keeps it stable
 * (idempotent re-runs target the same objects) AND well under the label limit
 * (`review-agent-` = 13 chars + 12 hex = 25). Exported so tests + teardown can
 * derive the same name the apply Job renders.
 */
export function agentReviewName(publishRequestId: string): string {
  // Lazy require: crypto is node-builtin, kept off the module top so this stays
  // import-cheap for the (dark) importers.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('crypto') as typeof import('crypto');
  const hash = createHash('sha1').update(publishRequestId).digest('hex').slice(0, 12);
  return `review-agent-${hash}`;
}

export type StartAgentReviewArgs = {
  publishRequestId: string;
  /** Calling moderator's id — recorded for audit; the agent produces mod
   *  decision-support, so the trigger is always moderator-bound. */
  modUserId: number;
};

export type StartAgentReviewResult = {
  reportId: string;
  agentName: string;
};

/**
 * Dispatch an ephemeral review agent for a PENDING on-site publish request.
 *
 * Steps (mirroring the review-sandbox lane's shape):
 *   a. Load the AppBlockPublishRequest (slug, bundle pointers, version, app key,
 *      forgejo commit).
 *   b. Resolve ONE presigned MinIO object the pod pulls: the canonical bundle
 *      (`bundleKey`) if the ZIP was uploaded, else reconstruct-from-Forgejo and
 *      stage it to a per-review key, then presign THAT. Either way the pod pulls
 *      one read-only object and never talks to Forgejo.
 *   c. Look up the prior-version report (base64 for the pod) so the agent can
 *      diff against the last review.
 *   d. Insert a `running` report row.
 *   e. Mint the per-review callback bearer (bound to publishRequestId).
 *   f. Provision the apply Job that envsubst-renders `review-agent.yaml.tmpl` +
 *      `kubectl apply`s it.
 *
 * On a provisioning failure the just-inserted row is flipped to `failed` so it
 * never lingers `running`.
 */
export async function startAgentReview(
  args: StartAgentReviewArgs
): Promise<StartAgentReviewResult> {
  const { publishRequestId } = args;
  const { dbRead, dbWrite } = await import('~/server/db/client');

  // (a) Load the pending on-site publish request. The whole review lane
  // (previewRequest / teardownReviewForRequest) targets AppBlockPublishRequest;
  // this mirrors it. (The connect / AppListingPublishRequest → oauthClientId path
  // is a separate flow, out of P1 scope — see the service docstring.)
  const request = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: {
      id: true,
      slug: true,
      version: true,
      bundleKey: true,
      bundleSha256: true,
      appBlockId: true,
      forgejoCommitSha: true,
      status: true,
    },
  });
  if (!request) throw new Error(`publish request ${publishRequestId} not found`);
  if (request.status !== 'pending') {
    throw new Error(
      `publish request ${publishRequestId} is not pending (status=${request.status})`
    );
  }

  // Double-provision guard (audit #3): refuse a second dispatch while a review is
  // already `running` for this request. The partial-unique index
  // (publish_request_id WHERE status='running') is the DB backstop; this is the
  // friendly pre-check so the mod gets a clear error instead of a unique-violation.
  const alreadyRunning = await dbRead.appReviewAgentReport.findFirst({
    where: { publishRequestId, status: 'running' },
    select: { id: true },
  });
  if (alreadyRunning) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'a review is already running for this request',
    });
  }

  // Resolve the INFORMATIONAL on-site app key. The report is keyed by the stable
  // `slug` (present on every request), so this is best-effort: an UPDATE carries
  // appBlockId, or an AppBlock already exists for the slug; a genuine FIRST
  // version has neither (the AppBlock is created on approve) → appBlockId stays
  // null. First-version reviews now persist fine (keyed by slug). External /
  // connect (oauthClientId) is out of P1 scope — TODO: a later phase keys those
  // by oauthClientId + kind='external'.
  let appBlockId = request.appBlockId ?? null;
  if (!appBlockId) {
    const existing = await dbRead.appBlock.findFirst({
      where: { blockId: request.slug },
      select: { id: true },
    });
    appBlockId = existing?.id ?? null;
  }

  const sha = request.bundleSha256;

  // (b) Resolve the ONE presigned object the pod pulls.
  let bundleObjectKey: string;
  if (request.bundleKey) {
    // ZIP path: the canonical bundle object already exists — presign it directly.
    bundleObjectKey = request.bundleKey;
  } else if (request.forgejoCommitSha) {
    // PUSH path (git-push origin, bundleKey===''): no ZIP was uploaded — the
    // Forgejo repo at the reviewed sha IS the artifact. Reconstruct the exact
    // reviewed bytes (deterministic; same helper approve uses) and STAGE them to
    // a per-review MinIO key so the pod pulls one presigned object (never Forgejo).
    const { reconstructBundleFromForgejo } = await import('./publish-request.service');
    const { agentReviewBundleKey, stageBundleObject } = await import('~/utils/bundle-s3');
    const buf = await reconstructBundleFromForgejo(request.slug, request.forgejoCommitSha);
    bundleObjectKey = agentReviewBundleKey(publishRequestId, sha);
    await stageBundleObject(bundleObjectKey, buf);
  } else {
    throw new Error(
      `publish request ${publishRequestId} has neither a bundle nor a forgejo commit to review`
    );
  }
  const { presignBundleGet } = await import('~/utils/bundle-s3');
  const bundlePresignedUrl = await presignBundleGet(
    bundleObjectKey,
    AGENT_REVIEW_BUNDLE_PRESIGN_TTL_SECONDS
  );

  // (c) Prior-version report → base64 JSON for the pod (empty string if none).
  // Keyed by the stable slug so the chain resolves for a first version too.
  const { getPriorAgentReport } = await import('./app-review-report.service');
  const prior = await getPriorAgentReport({ slug: request.slug, version: request.version });
  const priorReportJsonB64 = prior
    ? Buffer.from(JSON.stringify(prior)).toString('base64')
    : '';

  // (d) Insert the running report row. Keyed by `slug` (+ kind='onsite'); the
  // `appBlockId` column is informational (populated when resolvable, else null —
  // first versions have none). oauthClientId is left null (external/connect is out
  // of P1 scope).
  const { newAppReviewAgentReportId } = await import('~/server/utils/app-block-ids');
  const reportId = newAppReviewAgentReportId();
  await dbWrite.appReviewAgentReport.create({
    data: {
      id: reportId,
      publishRequestId,
      slug: request.slug,
      kind: 'onsite',
      appBlockId,
      version: request.version,
      bundleSha256: sha,
      status: 'running',
      startedAt: new Date(),
      priorReportId: prior?.id ?? null,
    },
  });

  // (e) Mint the per-review callback bearer bound to this publishRequestId. NOT
  // the fleet-wide BLOCK_BUILD_CALLBACK_SECRET — that must never reach the agent
  // pod. Short-TTL + review-scoped: a leaked token can only touch THIS report.
  const { signAgentCallbackToken } = await import('./review-session');
  const callbackToken = signAgentCallbackToken({ publishRequestId });
  // CONTAINMENT: prefer the IN-CLUSTER callback base (AGENT_REVIEW_CALLBACK_BASE_URL)
  // so the adversarial report + the per-review bearer never leave the cluster onto
  // the public internet. Falls back to the public NEXTAUTH_URL when the in-cluster
  // env is unset (keeps working before infra sets it ahead of un-dark). Read from
  // the VALIDATED env object, never process.env directly.
  const callbackBase = env.AGENT_REVIEW_CALLBACK_BASE_URL ?? env.NEXTAUTH_URL ?? '';
  const callbackUrl = `${callbackBase.replace(
    /\/$/,
    ''
  )}/api/internal/blocks/agent-report-callback`;

  const agentName = agentReviewName(publishRequestId);

  // (f) Provision the apply Job. On failure, flip the row to failed so it never
  // lingers `running`, then rethrow.
  try {
    // COST CEILING (audit #5): enforcement is POD-SIDE only — the runner self-aborts
    // (status 'cost-capped') once its LLM spend crosses COST_CAP_USD. There is NO
    // civitai-side spend ceiling in P1 (no per-mod/day budget, no global cap): an
    // accepted risk while the feature is DARK (mod-only, flag-gated), to revisit
    // before widening.
    await provisionAgentReviewJob({
      agentName,
      publishRequestId,
      slug: request.slug,
      bundlePresignedUrl,
      callbackUrl,
      callbackToken,
      priorReportJsonB64,
      costCapUsd: env.AGENT_REVIEW_COST_CAP_USD,
    });
  } catch (err) {
    await dbWrite.appReviewAgentReport
      .updateMany({
        where: { id: reportId, status: 'running' },
        data: {
          status: 'failed',
          summaryMd: `Provisioning failed: ${
            err instanceof Error ? err.message : String(err)
          }`.slice(0, 500),
          completedAt: new Date(),
        },
      })
      .catch(() => {
        /* best-effort — the caller already sees the throw */
      });
    throw err;
  }

  return { reportId, agentName };
}

type ProvisionAgentReviewJobArgs = {
  agentName: string;
  publishRequestId: string;
  slug: string;
  bundlePresignedUrl: string;
  callbackUrl: string;
  callbackToken: string;
  priorReportJsonB64: string;
  costCapUsd: string;
};

/**
 * Create the provisioning apply Job on dp-1's apps namespace. Mirrors
 * `triggerApplyReview`: same in-pod SA k8s surface, same `apps-applier` SA + the
 * same `app-templates` ConfigMap, but renders `review-agent.yaml.tmpl` with the
 * agent-review contract vars and applies it. The rendered objects carry the
 * template's labels (`civitai.com/role=review-agent`,
 * `civitai.com/publish-request-id=<id>`, `civitai.com/app-slug=<slug>`,
 * `review-mode=true`) — `deleteAgentReviewResources` sweeps on those.
 *
 * Exported so the orchestration test can lock the Job body + envsubst-var shape.
 */
export async function provisionAgentReviewJob(
  args: ProvisionAgentReviewJobArgs
): Promise<{ name: string }> {
  const target = await getDp1Target();
  const ns = env.APPS_KUBE_NAMESPACE;
  const jobName = `${args.agentName}-apply`;

  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: ns,
      labels: {
        app: jobName,
        'civitai.com/role': 'apply-job',
        'civitai.com/review-mode': 'true',
        'civitai.com/app-slug': args.slug,
        'civitai.com/publish-request-id': args.publishRequestId,
      },
    },
    spec: {
      backoffLimit: 2,
      // 24h TTL backstop — the approve/reject decision (teardownReviewForRequest)
      // tears the agent down; this only garbage-collects the apply Job itself.
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: {
          labels: {
            'civitai.com/role': 'apply-job',
            'civitai.com/review-mode': 'true',
            'civitai.com/app-slug': args.slug,
          },
        },
        spec: {
          serviceAccountName: 'apps-applier',
          restartPolicy: 'Never',
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'apply',
              image: 'alpine/k8s:1.34.0',
              imagePullPolicy: 'IfNotPresent',
              // Contract vars the shipped review-agent.yaml.tmpl consumes.
              // Object render vars + pod runtime env values (envsubst reads
              // process env, which container env vars auto-export into).
              // OPENROUTER_API_KEY is intentionally NOT passed — the pod reads it
              // from a namespace Secret.
              env: [
                { name: 'AGENT_NAME', value: args.agentName },
                { name: 'PUBLISH_REQUEST_ID', value: args.publishRequestId },
                { name: 'APP_SLUG', value: args.slug },
                { name: 'BUNDLE_PRESIGNED_URL', value: args.bundlePresignedUrl },
                { name: 'CALLBACK_URL', value: args.callbackUrl },
                { name: 'CALLBACK_TOKEN', value: args.callbackToken },
                { name: 'PRIOR_REPORT_JSON_B64', value: args.priorReportJsonB64 },
                { name: 'COST_CAP_USD', value: args.costCapUsd },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'templates', mountPath: '/templates', readOnly: true },
                { name: 'tmp', mountPath: '/tmp' },
              ],
              command: ['/bin/bash', '-c'],
              args: [buildAgentReviewApplyScript(ns)],
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
            },
          ],
          volumes: [
            { name: 'templates', configMap: { name: 'app-templates' } },
            { name: 'tmp', emptyDir: { sizeLimit: '8Mi' } },
          ],
        },
      },
    },
  };

  // Idempotency: re-dispatching for the same request must restart cleanly —
  // delete an existing same-name apply Job first (404 is fine). Mirrors the
  // review lane. The rendered Deployment/Service are reconciled by `kubectl
  // apply` inside the script.
  await k8sFetch(
    target,
    `/apis/batch/v1/namespaces/${ns}/jobs/${jobName}?propagationPolicy=Background`,
    { method: 'DELETE' }
  ).then(async (r) => {
    if (!r.ok && r.status !== 404) {
      const body = await r.text().catch(() => '');
      throw new Error(`pre-delete agent apply Job ${r.status}: ${body.slice(0, 240)}`);
    }
  });

  const res = await k8sFetch(target, `/apis/batch/v1/namespaces/${ns}/jobs`, {
    method: 'POST',
    body: JSON.stringify(job),
  });
  const created = await unwrap<{ metadata: { name: string } }>(res);
  return { name: created.metadata.name };
}

/**
 * The apply script: envsubst-render `review-agent.yaml.tmpl` + `kubectl apply`.
 *
 * SECURITY: unlike the review-sandbox apply script, this deliberately does NOT
 * `cat` the rendered manifest — it embeds the presigned bundle URL and the
 * callback bearer, which must not land in the apply-Job logs. There is also no
 * smoke test (the agent is not an HTTP block image; it pulls a bundle, analyses
 * it, and POSTs a report). Exported for the orchestration test.
 */
export function buildAgentReviewApplyScript(ns: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

# ---- Render the review-agent manifest from /templates/review-agent.yaml.tmpl --
# envsubst only substitutes EXPORTED env vars; container env vars are already
# exported into the process env, so AGENT_NAME / PUBLISH_REQUEST_ID / APP_SLUG /
# BUNDLE_PRESIGNED_URL / CALLBACK_URL / CALLBACK_TOKEN / PRIOR_REPORT_JSON_B64 /
# COST_CAP_USD all substitute.
if command -v envsubst >/dev/null 2>&1; then
  envsubst < /templates/review-agent.yaml.tmpl > /tmp/rendered.yaml
else
  sed -e "s|\\\${AGENT_NAME}|\${AGENT_NAME}|g" \\
      -e "s|\\\${PUBLISH_REQUEST_ID}|\${PUBLISH_REQUEST_ID}|g" \\
      -e "s|\\\${APP_SLUG}|\${APP_SLUG}|g" \\
      -e "s|\\\${BUNDLE_PRESIGNED_URL}|\${BUNDLE_PRESIGNED_URL}|g" \\
      -e "s|\\\${CALLBACK_URL}|\${CALLBACK_URL}|g" \\
      -e "s|\\\${CALLBACK_TOKEN}|\${CALLBACK_TOKEN}|g" \\
      -e "s|\\\${PRIOR_REPORT_JSON_B64}|\${PRIOR_REPORT_JSON_B64}|g" \\
      -e "s|\\\${COST_CAP_USD}|\${COST_CAP_USD}|g" \\
      /templates/review-agent.yaml.tmpl > /tmp/rendered.yaml
fi

# Do NOT cat /tmp/rendered.yaml — it contains the presigned URL + callback token.
echo "agent-review: rendered review-agent.yaml.tmpl for \${AGENT_NAME} (publish-request \${PUBLISH_REQUEST_ID})"

# ---- Apply the review-agent manifest into the namespace ---------------------
kubectl apply -f /tmp/rendered.yaml
echo "agent-review: applied objects for \${AGENT_NAME}"
`;
}

/**
 * Tear down an agent-review environment by label selector. Deletes the review-
 * agent Deployment(s) + Service(s) for a publish request. Best-effort +
 * idempotent: 404s are ignored, and a single failed resource type does not abort
 * the rest. NEVER throws — called from the decision-path teardown hook.
 *
 * Selector: `civitai.com/role=review-agent,civitai.com/publish-request-id=<id>`.
 * Scoped to the publish request AND the review-agent role, so it can only ever
 * match this review's agent objects — never a live app (a live app carries no
 * `review-agent` role) and never the review-SANDBOX preview (role=... not
 * review-agent).
 */
export async function deleteAgentReviewResources(args: {
  slug: string;
  publishRequestId: string;
}): Promise<void> {
  let target: Awaited<ReturnType<typeof getDp1Target>>;
  try {
    target = await getDp1Target();
  } catch (err) {
    // Not in-cluster / no SA token — nothing to tear down. Best-effort: swallow.
    // eslint-disable-next-line no-console
    console.warn(
      `[agent-review] deleteAgentReviewResources: no k8s target: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }
  const ns = env.APPS_KUBE_NAMESPACE;
  const selector = encodeURIComponent(
    `civitai.com/role=review-agent,civitai.com/publish-request-id=${args.publishRequestId}`
  );

  // LIST-then-DELETE-by-name (NOT deletecollection) so the feature needs only the
  // `list` + `delete` RBAC verbs — mirrors deleteReviewResources.
  const kinds: Array<{
    label: string;
    listPath: string;
    itemPath: (name: string) => string;
  }> = [
    {
      label: 'deployments',
      listPath: `/apis/apps/v1/namespaces/${ns}/deployments?labelSelector=${selector}`,
      itemPath: (name) => `/apis/apps/v1/namespaces/${ns}/deployments/${name}`,
    },
    {
      label: 'services',
      listPath: `/api/v1/namespaces/${ns}/services?labelSelector=${selector}`,
      itemPath: (name) => `/api/v1/namespaces/${ns}/services/${name}`,
    },
  ];

  for (const k of kinds) {
    try {
      const listRes = await k8sFetch(target, k.listPath, { method: 'GET' });
      if (!listRes.ok) {
        if (listRes.status !== 404) {
          const body = await listRes.text().catch(() => '');
          // eslint-disable-next-line no-console
          console.warn(
            `[agent-review] deleteAgentReviewResources list ${k.label} ${listRes.status}: ${body.slice(
              0,
              160
            )}`
          );
        }
        continue;
      }
      const list = await unwrap<{ items?: Array<{ metadata?: { name?: string } }> }>(listRes);
      const names = (list?.items ?? [])
        .map((it) => it?.metadata?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);

      for (const name of names) {
        try {
          const delRes = await k8sFetch(
            target,
            `${k.itemPath(name)}?propagationPolicy=Background`,
            { method: 'DELETE' }
          );
          if (!delRes.ok && delRes.status !== 404) {
            const body = await delRes.text().catch(() => '');
            // eslint-disable-next-line no-console
            console.warn(
              `[agent-review] deleteAgentReviewResources delete ${k.label}/${name} ${delRes.status}: ${body.slice(
                0,
                160
              )}`
            );
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[agent-review] deleteAgentReviewResources delete ${k.label}/${name} threw: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[agent-review] deleteAgentReviewResources ${k.label} threw: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
