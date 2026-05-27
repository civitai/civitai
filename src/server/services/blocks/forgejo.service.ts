/**
 * Forgejo REST client — server-side only.
 *
 * Wraps the Forgejo (Gitea-compatible) API surface civitai-web touches:
 * creating per-app repos under civitai-apps, attaching push webhooks
 * back to civitai-web, fetching the manifest at a specific commit for
 * post-push validation, and writing commit-status updates so a failed
 * build shows up in the repo's commit view.
 *
 * All calls auth as the admin token (FORGEJO_ADMIN_TOKEN) — Forgejo's
 * Authorization: token <PAT> scheme. At v0 the writer set is
 * civitai-team-only, so the admin scope is acceptable; v1 (W5 + W11)
 * tightens to per-user OAuth tokens.
 *
 * Network shape: civitai-web → forgejo-http.forgejo.svc.cluster.local:3000
 * inside the cluster, or → https://forgejo.civitaic.com from a PR-preview
 * env that doesn't have direct cluster DNS. FORGEJO_BASE_URL handles both.
 */

import { env } from '~/env/server';

const FORGEJO_ORG = 'civitai-apps';

function getBaseUrl(): string {
  const u = env.FORGEJO_BASE_URL;
  if (!u) throw new Error('FORGEJO_BASE_URL not configured');
  return u.replace(/\/$/, '');
}

function getAdminToken(): string {
  const t = env.FORGEJO_ADMIN_TOKEN;
  if (!t) throw new Error('FORGEJO_ADMIN_TOKEN not configured');
  return t;
}

function buildHeaders(): HeadersInit {
  return {
    Authorization: `token ${getAdminToken()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function fjFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  // 15s — Forgejo API calls should be sub-second; anything longer indicates
  // an in-cluster reachability problem worth surfacing fast.
  const res = await fetch(url, {
    ...init,
    headers: { ...buildHeaders(), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  return res;
}

async function unwrap<T>(res: Response, allowStatuses: number[] = []): Promise<T> {
  if (res.ok || allowStatuses.includes(res.status)) {
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (null as unknown as T);
  }
  const body = await res.text().catch(() => '');
  throw new Error(`Forgejo ${res.status} ${res.statusText}: ${body.slice(0, 240)}`);
}

export type ForgejoRepo = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
};

/**
 * Create a per-app repo under civitai-apps. If `template` is set, clones
 * from civitai-apps/<template> (typically `starter`) — this is how new
 * apps inherit the validated package.json / Dockerfile / vite.config.
 * Without a template the repo is empty; a manifest+code commit on `main`
 * is needed before the webhook triggers a build.
 *
 * Idempotent on the conflict case: if the repo already exists we return
 * the existing row instead of erroring, so a re-submission of the same
 * slug after a failed run continues forward cleanly.
 */
export async function createRepoFromTemplate(opts: {
  slug: string;
  description?: string;
  template?: string;
}): Promise<ForgejoRepo> {
  const body: Record<string, unknown> = {
    name: opts.slug,
    description: opts.description ?? '',
    private: true,
    auto_init: !opts.template,
    default_branch: 'main',
  };

  let endpoint = `/api/v1/orgs/${FORGEJO_ORG}/repos`;
  if (opts.template) {
    endpoint = `/api/v1/repos/${FORGEJO_ORG}/${opts.template}/generate`;
    body.owner = FORGEJO_ORG;
    body.git_content = true;
    delete body.default_branch;
    delete body.auto_init;
  }

  const res = await fjFetch(endpoint, { method: 'POST', body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) {
    // Already exists — fetch and return.
    return getRepo(opts.slug);
  }
  return unwrap<ForgejoRepo>(res);
}

export async function getRepo(slug: string): Promise<ForgejoRepo> {
  const res = await fjFetch(`/api/v1/repos/${FORGEJO_ORG}/${slug}`);
  return unwrap<ForgejoRepo>(res);
}

/** Grant a Forgejo username write access to the repo. */
export async function addCollaborator(opts: {
  slug: string;
  username: string;
  permission?: 'read' | 'write' | 'admin';
}): Promise<void> {
  const res = await fjFetch(
    `/api/v1/repos/${FORGEJO_ORG}/${opts.slug}/collaborators/${encodeURIComponent(opts.username)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ permission: opts.permission ?? 'write' }),
    }
  );
  // 204 No Content on success; 422 if already a collaborator with the same level.
  if (!res.ok && res.status !== 204 && res.status !== 422) {
    const body = await res.text().catch(() => '');
    throw new Error(`Forgejo addCollaborator ${res.status}: ${body.slice(0, 240)}`);
  }
}

/**
 * Attach a push webhook pointing at our webhook handler. HMAC secret is
 * read from FORGEJO_WEBHOOK_SECRET so all repos share the same key (the
 * receiver doesn't need per-repo state to verify). If a webhook with the
 * same URL exists, replace it — keeps re-submissions idempotent.
 */
export async function ensurePushWebhook(opts: {
  slug: string;
  callbackUrl: string;
  secret: string;
}): Promise<void> {
  // List existing webhooks; we don't want to stack identical ones.
  const list = await fjFetch(`/api/v1/repos/${FORGEJO_ORG}/${opts.slug}/hooks`);
  const hooks = await unwrap<Array<{ id: number; config: { url?: string } }>>(list);
  for (const h of hooks) {
    if (h.config?.url === opts.callbackUrl) {
      await fjFetch(`/api/v1/repos/${FORGEJO_ORG}/${opts.slug}/hooks/${h.id}`, {
        method: 'DELETE',
      });
    }
  }
  const create = await fjFetch(`/api/v1/repos/${FORGEJO_ORG}/${opts.slug}/hooks`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'gitea',
      active: true,
      events: ['push'],
      config: {
        url: opts.callbackUrl,
        content_type: 'json',
        secret: opts.secret,
      },
    }),
  });
  await unwrap<unknown>(create);
}

/**
 * Fetch a single file at a specific ref. Used to read block.manifest.json
 * out of the just-pushed commit. Returns the raw bytes (typically JSON).
 */
export async function getRawFile(opts: {
  slug: string;
  ref: string;
  path: string;
}): Promise<string> {
  const url = `${getBaseUrl()}/${FORGEJO_ORG}/${opts.slug}/raw/commit/${opts.ref}/${opts.path}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${getAdminToken()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Forgejo raw ${res.status}: ${body.slice(0, 240)}`);
  }
  return res.text();
}

/**
 * Write a commit status — shows up on the repo's commit + branch views.
 * Lets developers see `pending`/`success`/`failure` for the build and
 * deploy steps directly in Forgejo without tabbing back to civitai.
 */
export async function setCommitStatus(opts: {
  slug: string;
  sha: string;
  state: 'pending' | 'success' | 'error' | 'failure' | 'warning';
  context: string; // e.g. 'civitai/build' or 'civitai/deploy'
  description?: string;
  targetUrl?: string;
}): Promise<void> {
  const res = await fjFetch(`/api/v1/repos/${FORGEJO_ORG}/${opts.slug}/statuses/${opts.sha}`, {
    method: 'POST',
    body: JSON.stringify({
      state: opts.state,
      context: opts.context,
      description: (opts.description ?? '').slice(0, 140),
      target_url: opts.targetUrl ?? '',
    }),
  });
  await unwrap<unknown>(res);
}
