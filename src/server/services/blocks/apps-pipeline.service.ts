/**
 * apps-pipeline.service — bridges Forgejo pushes to the build + apply
 * pipeline.
 *
 * Two surfaces:
 *   1. triggerBuild()  — POSTs a JSON payload to the app-blocks-trigger
 *                        receiver on dc-02-a, which validates HMAC and
 *                        creates a PipelineRun via its in-pod ServiceAccount.
 *                        Reached via the dp-1 VPN proxy at
 *                        wireguard-proxy-service.civitai-submodel-proxy.svc:8088.
 *                        Called by the Forgejo push webhook handler.
 *   2. triggerApply()  — POSTs an apply Job to dp-1's civitai-apps
 *                        namespace via the in-pod ServiceAccount token.
 *                        Called by Tekton's build-callback handler.
 *
 * Both surfaces are intentionally thin REST wrappers — no kubernetes-client
 * dependency, no node-kubernetes-client surface. The Job spec is an inline
 * string template; the PipelineRun spec lives entirely server-side in the
 * trigger receiver.
 *
 * For the dp-1 side (triggerApply) we use the pod's auto-mounted token
 * (/var/run/secrets/kubernetes.io/serviceaccount/token) — civitai-pr-2319's
 * default SA is bound to the civitai-web-apps-consumer Role in civitai-apps
 * (see datapacket-talos/clusters/production/apps/civitai-apps/rbac.yaml).
 *
 * For the dc-02-a side (triggerBuild), the original W2 design parsed a
 * kubeconfig and posted PipelineRuns directly to dc-02-a's API server.
 * That doesn't work — dc-02-a's API is loopback-only (SSH-tunnel for
 * operators). We switched to an HMAC-protected trigger receiver: see
 * datapacket-talos/claudedocs/app-blocks-tekton-trigger/ for the manifest.
 */

import { createHmac } from 'crypto';
import { readFile } from 'node:fs/promises';
import { env } from '~/env/server';

// ---------- shared HTTP helpers --------------------------------------------

type K8sTarget = {
  server: string;
  token: string;
};

async function k8sFetch(target: K8sTarget, path: string, init?: RequestInit): Promise<Response> {
  const url = `${target.server.replace(/\/$/, '')}${path}`;
  const headers: HeadersInit = {
    Authorization: `Bearer ${target.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(init?.headers ?? {}),
  };
  return fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
}

async function unwrap<T>(res: Response, allowStatuses: number[] = []): Promise<T> {
  if (res.ok || allowStatuses.includes(res.status)) {
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (null as unknown as T);
  }
  const body = await res.text().catch(() => '');
  throw new Error(`k8s API ${res.status} ${res.statusText}: ${body.slice(0, 240)}`);
}

// ---------- in-cluster (dp-1) target ---------------------------------------

let dp1Target: K8sTarget | null = null;
async function getDp1Target(): Promise<K8sTarget> {
  if (dp1Target) return dp1Target;
  // Standard in-pod paths.
  const token = await readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
  // KUBERNETES_SERVICE_HOST + PORT are auto-set in every pod.
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) throw new Error('not running in-cluster (no KUBERNETES_SERVICE_HOST)');
  dp1Target = {
    server: `https://${host}:${port}`,
    token: token.trim(),
    // The in-pod CA bundle is at the standard path; Node's default fetch
    // honours NODE_EXTRA_CA_CERTS pointing at it. The Deployment patch
    // exports NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    // so this just works without extra wiring here.
  };
  return dp1Target;
}

// ---------- triggerBuild — HMAC POST to app-blocks-trigger -----------------

export type TriggerBuildArgs = {
  slug: string;
  sha: string;
  appBlockId: string;
  callbackUrl: string;
};

export async function triggerBuild(args: TriggerBuildArgs): Promise<{ name: string }> {
  const url = env.APPS_TEKTON_TRIGGER_URL;
  const secret = env.APPS_TEKTON_TRIGGER_SECRET;
  if (!url || !secret) {
    throw new Error('APPS_TEKTON_TRIGGER_URL / APPS_TEKTON_TRIGGER_SECRET not configured');
  }

  // F5 — replay-protection timestamp. Integer unix-epoch SECONDS, placed INSIDE
  // the JSON body BEFORE the HMAC so it is covered by the signature and sent
  // verbatim. The app-blocks-trigger receiver on talos ALREADY validates
  // |now-ts| <= 300 ENFORCE-IF-PRESENT (app-blocks-trigger.py TS_SKEW_SECONDS),
  // so adding it here activates that already-live (currently inert) check. Must
  // match the receiver's contract exactly: field name `ts`, integer seconds.
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    slug: args.slug,
    sha: args.sha,
    appBlockId: args.appBlockId,
    callbackUrl: args.callbackUrl,
    ts,
  });
  const sig = createHmac('sha256', secret).update(body).digest('hex');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AppBlocks-Trigger-Sig': sig,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`trigger ${res.status} ${res.statusText}: ${text.slice(0, 240)}`);
  }

  let parsed: { pipelineRun?: string } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // Receiver should always return JSON; if not, surface a clear error.
    throw new Error(`trigger response was not JSON: ${text.slice(0, 240)}`);
  }
  return { name: parsed.pipelineRun ?? '' };
}

// ---------- triggerApply — apply Job on dp-1 civitai-apps ------------------

export type TriggerApplyArgs = {
  slug: string;
  sha: string;
  appBlockId: string;
  imageRef: string;
};

export async function triggerApply(args: TriggerApplyArgs): Promise<{ name: string }> {
  const target = await getDp1Target();
  const ns = env.APPS_KUBE_NAMESPACE;
  const jobName = `${args.slug}-apply-${args.sha.slice(0, 8)}`;

  // Construct the Job spec inline. Keep in sync with
  // datapacket-talos/clusters/production/apps/civitai-apps/templates/apply-job-template.yaml
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: ns,
      labels: {
        app: jobName,
        'civitai.com/role': 'apply-job',
        'civitai.com/app-slug': args.slug,
        'civitai.com/app-block-id': args.appBlockId,
      },
    },
    spec: {
      backoffLimit: 2,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: {
          labels: {
            'civitai.com/role': 'apply-job',
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
              env: [
                { name: 'SLUG', value: args.slug },
                { name: 'SHA', value: args.sha },
                { name: 'IMAGE', value: args.imageRef },
                { name: 'APP_BLOCK_ID', value: args.appBlockId },
                { name: 'APPS_DOMAIN', value: env.APPS_DOMAIN },
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
              args: [buildApplyScript(ns)],
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

  // Delete an existing Job by the same name first (re-pushes of the same
  // SHA must restart the apply cycle, not silently succeed because the
  // first one finished).
  await k8sFetch(target, `/apis/batch/v1/namespaces/${ns}/jobs/${jobName}?propagationPolicy=Background`, {
    method: 'DELETE',
  }).then(async (r) => {
    // 404 is fine — first time we're applying for this SHA.
    if (!r.ok && r.status !== 404) {
      const body = await r.text().catch(() => '');
      throw new Error(`pre-delete Job ${r.status}: ${body.slice(0, 240)}`);
    }
  });

  const res = await k8sFetch(target, `/apis/batch/v1/namespaces/${ns}/jobs`, {
    method: 'POST',
    body: JSON.stringify(job),
  });
  const created = await unwrap<{ metadata: { name: string } }>(res);
  return { name: created.metadata.name };
}

// ---------- waitForApplyJob — poll until Succeeded / Failed / timeout ------

export type ApplyJobOutcome = 'succeeded' | 'failed' | 'timeout';

type JobStatusShape = {
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
  };
};

/**
 * Poll the apply Job until it terminates or `timeoutMs` elapses. Returns
 * 'succeeded' iff Kubernetes flips `.status.succeeded >= 1` AND no
 * Failed condition. Returns 'failed' as soon as a Failed condition lands
 * (BackoffLimitExceeded, DeadlineExceeded, etc.) so the caller can react
 * without waiting for the full timeout. 'timeout' means we gave up — the
 * Job may still finish later, but the caller's state machine has moved
 * on.
 *
 * Used by the build-callback handler to defer the
 * app_blocks.current_version_deployed_at write until the new Deployment
 * is actually serving — closes gotcha #39's data-consistency gap.
 */
export async function waitForApplyJob(
  jobName: string,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<ApplyJobOutcome> {
  const target = await getDp1Target();
  const ns = env.APPS_KUBE_NAMESPACE;
  const timeoutMs = opts.timeoutMs ?? 6 * 60 * 1000; // 6 min — fits the worst-case backoffLimit=2 + 180s rollout
  const pollMs = opts.pollMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let body: JobStatusShape | null = null;
    try {
      const res = await k8sFetch(target, `/apis/batch/v1/namespaces/${ns}/jobs/${jobName}`, {
        method: 'GET',
      });
      // 404 = Job GC'd (ttlSecondsAfterFinished elapsed) or never created.
      // Treat as a no-signal terminal — the caller should already have
      // gotten triggerApply's name, so 404 here means we missed the window.
      if (res.status === 404) return 'timeout';
      body = await unwrap<JobStatusShape>(res);
    } catch (err) {
      // Transient k8s API hiccup — retry on the next poll tick.
      // eslint-disable-next-line no-console
      console.warn(
        `[apps-pipeline] waitForApplyJob GET ${jobName} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    const status = body?.status;
    if (status) {
      // Succeeded: Kubernetes increments succeeded as Pods complete. With
      // backoffLimit > 0 and parallelism unset (defaults to 1), a single
      // success increments to 1 and the Job moves to Complete condition.
      if ((status.succeeded ?? 0) >= 1) return 'succeeded';
      // Failed: a terminal Failed condition (BackoffLimitExceeded /
      // DeadlineExceeded) is the cleanest "give up" signal. Don't rely on
      // .status.failed (which counts individual Pod attempts and can climb
      // mid-retry without the Job being terminal).
      const failed = status.conditions?.find(
        (c) => c.type === 'Failed' && c.status === 'True'
      );
      if (failed) return 'failed';
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return 'timeout';
}

// ---------- apply-Job inner script (rendered into spec.containers[].args)

/**
 * The bash script that runs inside the apply Job. Renders the per-app
 * manifest, runs a pre-flight smoke test against the new image, and
 * only then `kubectl apply`s the manifest into the live namespace.
 *
 * Smoke test fixes 2026-05-29's gen-from-model incident: a bundle with
 * Vite `base: '/<slug>/'` + nginx redirect from `/` shipped clean, then
 * mixed-content-blocked in the iframe because the redirect Location
 * leaked the in-pod port (:8080) through Traefik to the browser. The
 * smoke test catches that EXACT pattern by spinning up the candidate
 * image as a Pod, hitting it directly, and rejecting any redirect
 * whose Location embeds the in-pod port — a strong signal the bundle
 * would mixed-content-block the iframe under HTTPS.
 *
 * Failures during the smoke test exit non-zero so the Job is marked
 * Failed and the live Deployment is left untouched. The build chain
 * surfaces this back to civitai-web via the standard apply Job watch.
 *
 * Exported for the orchestration tests so the smoke shape stays
 * locked-in.
 */
export function buildApplyScript(ns: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

# ---- Render the per-app manifest from /templates/app.yaml.tmpl --------------
if command -v envsubst >/dev/null 2>&1; then
  envsubst < /templates/app.yaml.tmpl > /tmp/rendered.yaml
else
  sed -e "s|\\\${SLUG}|\${SLUG}|g" \\
      -e "s|\\\${SHA}|\${SHA}|g" \\
      -e "s|\\\${IMAGE}|\${IMAGE}|g" \\
      -e "s|\\\${APP_BLOCK_ID}|\${APP_BLOCK_ID}|g" \\
      -e "s|\\\${APPS_DOMAIN}|\${APPS_DOMAIN}|g" \\
      /templates/app.yaml.tmpl > /tmp/rendered.yaml
fi
cat /tmp/rendered.yaml

# ---- Pre-flight smoke test against the candidate image ---------------------
# 8-char short SHA keeps the pod name under the 63-char DNS label limit.
SMOKE_POD="smoke-\${SLUG}-$(printf '%s' "\${SHA}" | head -c 8)"
echo "smoke test: creating pod \${SMOKE_POD} from \${IMAGE}"

# Pod overrides:
#   - imagePullSecrets ghcr-cred — block-app images are private ghcr repos;
#     without this the smoke pod sits in ImagePullBackOff and the wait
#     times out (2026-05-30 incident: first apply Job to run the smoke
#     step failed exactly this way).
#   - automountServiceAccountToken: false — the smoke pod doesn't need RBAC.
#   - runAsNonRoot enforced (matches PodSecurity:restricted on civitai-apps);
#     does NOT pin a specific UID, so any non-root image (nginx user 101,
#     node user 1000, etc.) is accepted.
#   - capabilities drop ALL + seccompProfile RuntimeDefault for PSA.
kubectl -n ${ns} run "\${SMOKE_POD}" --image="\${IMAGE}" --restart=Never \\
  --port=8080 --labels="civitai.com/role=smoke,civitai.com/app-slug=\${SLUG}" \\
  --overrides='{"spec":{"imagePullSecrets":[{"name":"ghcr-cred"}],"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"smoke","image":"'\${IMAGE}'","ports":[{"containerPort":8080}],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}'

# Always clean up the smoke pod, even if the script fails mid-way.
cleanup() {
  kubectl -n ${ns} delete pod "\${SMOKE_POD}" --wait=false --ignore-not-found=true >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! kubectl -n ${ns} wait "pod/\${SMOKE_POD}" --for=condition=Ready --timeout=60s; then
  echo "smoke test: pod failed to become Ready within 60s" >&2
  kubectl -n ${ns} describe "pod/\${SMOKE_POD}" || true
  kubectl -n ${ns} logs "pod/\${SMOKE_POD}" --tail=80 || true
  exit 1
fi

POD_IP=$(kubectl -n ${ns} get "pod/\${SMOKE_POD}" -o jsonpath='{.status.podIP}')
echo "smoke test: pod IP \${POD_IP}"

# Probe 1: /healthz must return 200.
HZ=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://\${POD_IP}:8080/healthz" || echo "000")
if [ "\${HZ}" != "200" ]; then
  echo "smoke test: GET /healthz returned \${HZ} (expected 200)" >&2
  exit 1
fi

# Probe 2: GET / must return 200 + text/html after at most one redirect.
ROOT=$(curl -sS -i -L --max-redirs 1 --max-time 15 "http://\${POD_IP}:8080/" || true)
ROOT_STATUS=$(printf '%s\\n' "\${ROOT}" | awk '/^HTTP\\// {s=$2} END {print s}')
ROOT_CT=$(printf '%s\\n' "\${ROOT}" | awk -F': ' 'tolower($1)=="content-type"{print tolower($2); exit}' | tr -d '\\r')

if [ "\${ROOT_STATUS}" != "200" ]; then
  echo "smoke test: GET / final status \${ROOT_STATUS} (expected 200)" >&2
  printf '%s\\n' "\${ROOT}" | head -20 >&2
  exit 1
fi
case "\${ROOT_CT}" in
  *text/html*) ;;
  *)
    echo "smoke test: GET / Content-Type was '\${ROOT_CT}' (expected text/html)" >&2
    exit 1
    ;;
esac

# Probe 3: catch the gen-from-model mixed-content trap. Any Location
# header in the redirect chain whose value embeds the in-pod listen
# port (:8080) means nginx is leaking $server_port — under Traefik's
# HTTPS terminator this becomes "http://<slug>.civit.ai:8080/..." in
# the browser, which mixed-content-blocks the iframe. Reject hard.
if printf '%s\\n' "\${ROOT}" | awk -F': ' 'tolower($1)=="location"{print $2}' | grep -q ':8080'; then
  BAD=$(printf '%s\\n' "\${ROOT}" | awk -F': ' 'tolower($1)=="location"{print $2}' | tr -d '\\r' | head -1)
  echo "smoke test: redirect Location leaks the in-pod port — will trigger" >&2
  echo "  browser mixed-content block when served behind HTTPS Traefik." >&2
  echo "  Location: \${BAD}" >&2
  echo "  Common cause: bundler base path + nginx redirect from /." >&2
  exit 1
fi

echo "smoke test: PASSED — healthz 200, / 200 text/html, no port-leak redirect"

# ---- Apply the per-app manifest into the live namespace --------------------
kubectl apply -f /tmp/rendered.yaml
kubectl -n ${ns} rollout status deploy/\${SLUG} --timeout=180s
`;
}
