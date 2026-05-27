/**
 * apps-pipeline.service — bridges Forgejo pushes to the build + apply
 * pipeline.
 *
 * Two surfaces:
 *   1. triggerBuild()  — POSTs a PipelineRun to dc-02-a Tekton via the
 *                        REST API (kubeconfig mounted from APPS_TEKTON_KUBECONFIG).
 *                        Called by the Forgejo push webhook handler.
 *   2. triggerApply()  — POSTs an apply Job to dp-1's civitai-apps
 *                        namespace via the in-pod ServiceAccount token.
 *                        Called by Tekton's build-callback handler.
 *
 * Both surfaces are intentionally thin REST wrappers — no kubernetes-client
 * dependency, no node-kubernetes-client surface. The PipelineRun and Job
 * specs are inline string templates; substitute slug/sha/image/appBlockId
 * via JSON construction.
 *
 * For the dp-1 side we use the pod's auto-mounted token
 * (/var/run/secrets/kubernetes.io/serviceaccount/token) — civitai-pr-2319's
 * default SA is bound to the civitai-web-apps-consumer Role in civitai-apps
 * (see datapacket-talos/clusters/production/apps/civitai-apps/rbac.yaml).
 *
 * For the dc-02-a side we load a kubeconfig YAML from APPS_TEKTON_KUBECONFIG
 * and extract server + cluster CA + user token. The kubeconfig is mounted
 * from a SOPS-encrypted Secret in the civitai-web Deployment.
 */

import { readFile } from 'node:fs/promises';
import * as YAML from 'yaml';
import { env } from '~/env/server';

// ---------- shared HTTP helpers --------------------------------------------

type K8sTarget = {
  server: string;
  token: string;
  caBundle?: string; // PEM
  insecureSkipTLS?: boolean;
};

async function k8sFetch(target: K8sTarget, path: string, init?: RequestInit): Promise<Response> {
  const url = `${target.server.replace(/\/$/, '')}${path}`;
  const headers: HeadersInit = {
    Authorization: `Bearer ${target.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(init?.headers ?? {}),
  };

  // Node's fetch lets us pass a custom `dispatcher` for CA validation,
  // but for simplicity we lean on NODE_EXTRA_CA_CERTS at process startup
  // (the kubeconfig's CA cert gets written to a file and exported via
  // NODE_EXTRA_CA_CERTS in the Deployment). If insecureSkipTLS is set,
  // we'd want process.env.NODE_TLS_REJECT_UNAUTHORIZED='0' — but that's
  // a sledgehammer; prefer NODE_EXTRA_CA_CERTS path.

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

// ---------- dc-02-a target (Tekton) ----------------------------------------

let tektonTarget: K8sTarget | null = null;
async function getTektonTarget(): Promise<K8sTarget> {
  if (tektonTarget) return tektonTarget;
  const path = env.APPS_TEKTON_KUBECONFIG;
  if (!path) throw new Error('APPS_TEKTON_KUBECONFIG not configured');
  const raw = await readFile(path, 'utf8');
  const cfg = YAML.parse(raw) as {
    clusters: Array<{ name: string; cluster: { server: string; 'certificate-authority-data'?: string; 'insecure-skip-tls-verify'?: boolean } }>;
    users: Array<{ name: string; user: { token?: string; 'token-file'?: string } }>;
    contexts: Array<{ name: string; context: { cluster: string; user: string; namespace?: string } }>;
    'current-context': string;
  };
  const ctxName = cfg['current-context'];
  const ctx = cfg.contexts.find((c) => c.name === ctxName);
  if (!ctx) throw new Error(`current-context ${ctxName} not in kubeconfig`);
  const cluster = cfg.clusters.find((c) => c.name === ctx.context.cluster);
  const user = cfg.users.find((u) => u.name === ctx.context.user);
  if (!cluster || !user) throw new Error('kubeconfig missing cluster or user entry');

  const token =
    user.user.token ??
    (user.user['token-file'] ? await readFile(user.user['token-file'], 'utf8') : undefined);
  if (!token) throw new Error('kubeconfig user has no token (only token / token-file supported)');

  const caBundle = cluster.cluster['certificate-authority-data']
    ? Buffer.from(cluster.cluster['certificate-authority-data'], 'base64').toString('utf8')
    : undefined;

  tektonTarget = {
    server: cluster.cluster.server,
    token: token.trim(),
    caBundle,
    insecureSkipTLS: cluster.cluster['insecure-skip-tls-verify'] === true,
  };
  return tektonTarget;
}

// ---------- triggerBuild — Tekton PipelineRun on dc-02-a -------------------

export type TriggerBuildArgs = {
  slug: string;
  sha: string;
  appBlockId: string;
  callbackUrl: string;
};

export async function triggerBuild(args: TriggerBuildArgs): Promise<{ name: string }> {
  const target = await getTektonTarget();
  const ns = env.APPS_TEKTON_NAMESPACE;
  const runName = `app-blocks-${args.slug}-${args.sha.slice(0, 8)}-${Date.now().toString(36)}`;

  const pipelineRun = {
    apiVersion: 'tekton.dev/v1',
    kind: 'PipelineRun',
    metadata: {
      name: runName,
      namespace: ns,
      labels: {
        'civitai.com/app-block-id': args.appBlockId,
        'civitai.com/app-slug': args.slug,
        'civitai.com/app-block-sha': args.sha,
        'tekton.dev/pipeline': 'app-blocks-build-and-publish',
      },
    },
    spec: {
      pipelineRef: { name: 'app-blocks-build-and-publish' },
      serviceAccountName: 'app-blocks-builder',
      params: [
        { name: 'slug', value: args.slug },
        { name: 'sha', value: args.sha },
        { name: 'app-block-id', value: args.appBlockId },
        { name: 'callback-url', value: args.callbackUrl },
      ],
      workspaces: [
        {
          name: 'source',
          volumeClaimTemplate: {
            spec: {
              accessModes: ['ReadWriteOnce'],
              resources: { requests: { storage: '2Gi' } },
            },
          },
        },
      ],
      timeouts: { pipeline: '20m', tasks: '15m', finally: '5m' },
    },
  };

  const res = await k8sFetch(
    target,
    `/apis/tekton.dev/v1/namespaces/${ns}/pipelineruns`,
    { method: 'POST', body: JSON.stringify(pipelineRun) }
  );
  const created = await unwrap<{ metadata: { name: string } }>(res);
  return { name: created.metadata.name };
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
