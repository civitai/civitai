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

  const body = JSON.stringify({
    slug: args.slug,
    sha: args.sha,
    appBlockId: args.appBlockId,
    callbackUrl: args.callbackUrl,
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
              image: 'bitnami/kubectl:1.34',
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
              args: [
                [
                  'set -euo pipefail',
                  'if command -v envsubst >/dev/null 2>&1; then',
                  '  envsubst < /templates/app.yaml.tmpl > /tmp/rendered.yaml',
                  'else',
                  '  sed -e "s|\\${SLUG}|${SLUG}|g" \\',
                  '      -e "s|\\${SHA}|${SHA}|g" \\',
                  '      -e "s|\\${IMAGE}|${IMAGE}|g" \\',
                  '      -e "s|\\${APP_BLOCK_ID}|${APP_BLOCK_ID}|g" \\',
                  '      -e "s|\\${APPS_DOMAIN}|${APPS_DOMAIN}|g" \\',
                  '      /templates/app.yaml.tmpl > /tmp/rendered.yaml',
                  'fi',
                  'cat /tmp/rendered.yaml',
                  'kubectl apply -f /tmp/rendered.yaml',
                  'kubectl -n ' + ns + ' rollout status deploy/${SLUG} --timeout=180s',
                ].join('\n'),
              ],
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
