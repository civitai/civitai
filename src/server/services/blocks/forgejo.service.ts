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
 * inside the cluster, or → https://forgejo.civitai.com from a PR-preview
 * env that doesn't have direct cluster DNS. FORGEJO_BASE_URL handles both.
 */

import { randomBytes } from 'crypto';
import { env } from '~/env/server';

export const FORGEJO_ORG = 'civitai-apps';
const FORGEJO_REVIEW_ORG = 'civitai-apps-review';

/**
 * Public URL pointer for the in-review repo of a slug. Used by the
 * UI to deep-link mods into Forgejo's diff view from /apps/review.
 *
 * Uses FORGEJO_PUBLIC_URL (browser-facing host) rather than
 * FORGEJO_BASE_URL (cluster-internal service URL used for civitai-web's
 * own API + webhook calls).
 */
export function reviewRepoUrl(slug: string): string {
  const u = env.FORGEJO_PUBLIC_URL.replace(/\/$/, '');
  return `${u}/${FORGEJO_REVIEW_ORG}/${slug}`;
}

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

/**
 * Recursively list every blob in the repo's branch HEAD as
 * Map<path, sha>. Used by `commitFiles` to know which paths need
 * delete-vs-update, and to look up blob SHAs for updates. Also used
 * by the W1 backfill to know what files to pull when reconstructing
 * a bundle from a live Forgejo repo.
 */
export async function listRepoTree(
  slug: string,
  branch: string,
  org: string = FORGEJO_ORG
): Promise<Map<string, string>> {
  const branchRes = await fjFetch(
    `/api/v1/repos/${org}/${slug}/branches/${encodeURIComponent(branch)}`
  );
  const branchInfo = await unwrap<{ commit: { id: string } }>(branchRes);
  return listRepoTreeAtRef(slug, branchInfo.commit.id, org);
}

/**
 * Recursively list every blob in the repo at an arbitrary git ref —
 * a commit SHA (NOT just a branch name) — as Map<path, blob-sha>. Same
 * shape as `listRepoTree`, but skips the branch→commit lookup so the
 * caller can snapshot a specific historical commit (e.g. the sha a
 * git-push parked on a pending review request).
 *
 * Forgejo's `git/trees/<ref>` resolves a commit ref to its root tree, so
 * passing a commit SHA returns that commit's full recursive blob list.
 */
export async function listRepoTreeAtRef(
  slug: string,
  ref: string,
  org: string = FORGEJO_ORG
): Promise<Map<string, string>> {
  const treeRes = await fjFetch(
    `/api/v1/repos/${org}/${slug}/git/trees/${encodeURIComponent(ref)}?recursive=true&per_page=1000`
  );
  const tree = await unwrap<{
    tree: Array<{ path: string; type: string; sha: string }>;
    truncated?: boolean;
  }>(treeRes);
  if (tree.truncated) {
    throw new Error(
      `Forgejo tree for ${slug}@${ref} is truncated (>1000 entries); pagination not implemented`
    );
  }
  const result = new Map<string, string>();
  for (const item of tree.tree) {
    if (item.type === 'blob') result.set(item.path, item.sha);
  }
  return result;
}

/**
 * Fetch a blob's raw bytes by its git object SHA. Used by the W1
 * backfill to reconstruct a bundle from a live Forgejo repo (one HTTP
 * call per blob; for repos with hundreds of files the caller should
 * batch through Promise.all).
 *
 * Forgejo's blobs endpoint returns the content base64-encoded inside a
 * JSON envelope; we decode here so the caller gets a plain Buffer.
 */
export async function getBlobContent(slug: string, sha: string): Promise<Buffer> {
  const res = await fjFetch(`/api/v1/repos/${FORGEJO_ORG}/${slug}/git/blobs/${sha}`);
  const blob = await unwrap<{ content: string; encoding: string }>(res);
  if (blob.encoding !== 'base64') {
    throw new Error(
      `Forgejo blob ${sha} returned unexpected encoding ${blob.encoding}`
    );
  }
  return Buffer.from(blob.content, 'base64');
}

/**
 * Replace the contents of `main` with a single atomic commit:
 *   - create files in `files` that aren't already in the repo
 *   - update files in `files` that differ from the repo
 *   - delete files in the repo that aren't in `files` (when
 *     `replaceAllFiles` is true)
 *
 * Single multi-file commit means: one push event, one webhook fire,
 * one Tekton build, one apply. Avoids the N-PUTs-N-builds storm of
 * file-by-file uploads.
 *
 * `files[].content` must be a Buffer (text or binary); function
 * base64-encodes for the Forgejo API.
 */
export async function commitFiles(opts: {
  slug: string;
  files: Array<{ path: string; content: Buffer }>;
  message: string;
  branch?: string;
  replaceAllFiles?: boolean;
  /** Defaults to `civitai-apps` (the canonical, build-trigger org). The
   *  in-review repo flow passes `civitai-apps-review`. */
  org?: string;
}): Promise<{ sha: string }> {
  const branch = opts.branch ?? 'main';
  const org = opts.org ?? FORGEJO_ORG;
  const tree = await listRepoTree(opts.slug, branch, org);
  const targetPaths = new Set(opts.files.map((f) => f.path));

  const operations: Array<{
    operation: 'create' | 'update' | 'delete';
    path: string;
    content?: string;
    sha?: string;
  }> = [];

  for (const file of opts.files) {
    const existingSha = tree.get(file.path);
    const contentB64 = file.content.toString('base64');
    if (existingSha) {
      operations.push({
        operation: 'update',
        path: file.path,
        content: contentB64,
        sha: existingSha,
      });
    } else {
      operations.push({
        operation: 'create',
        path: file.path,
        content: contentB64,
      });
    }
  }

  if (opts.replaceAllFiles) {
    for (const [path, sha] of tree) {
      if (!targetPaths.has(path)) {
        operations.push({ operation: 'delete', path, sha });
      }
    }
  }

  if (operations.length === 0) {
    // Nothing to commit (bundle identical to repo state). Caller can
    // treat this as a no-op approve. Return current HEAD SHA so the
    // publish_request still gets a forgejo_commit_sha pointer.
    const branchRes = await fjFetch(
      `/api/v1/repos/${org}/${opts.slug}/branches/${encodeURIComponent(branch)}`
    );
    const branchInfo = await unwrap<{ commit: { id: string } }>(branchRes);
    return { sha: branchInfo.commit.id };
  }

  const res = await fjFetch(`/api/v1/repos/${org}/${opts.slug}/contents`, {
    method: 'POST',
    body: JSON.stringify({
      files: operations,
      message: opts.message,
      branch,
    }),
  });
  const result = await unwrap<{ commit: { sha: string } }>(res);
  return { sha: result.commit.sha };
}

// ---------------------------------------------------------------------------
// Phase 3 (git-push self-service) — per-user Forgejo identity provisioning.
//
// These functions mint a SCOPED, restricted Forgejo user + token for a civitai
// developer so they can `git push` to their own civitai-apps/<slug> repo. The
// admin token (createForgejoUser / getForgejoUser) creates/looks up the user;
// the user's OWN HTTP-Basic creds (mintForgejoUserToken) mint their token —
// Forgejo refuses to mint a user token via the admin PAT.
//
// Isolation: the created user is `restricted:true` + `visibility:'private'`, so
// it has NO ambient access; write on a specific repo comes only from an explicit
// addCollaborator call (the dev-git-access flow). A push still parks a pending
// review request and can NEVER deploy without mod approval.
// ---------------------------------------------------------------------------

export type ForgejoUser = { id: number; username: string };

/**
 * Random Forgejo password for a provisioned dev user. 32 hex chars (16 bytes
 * of entropy) clears Forgejo's MIN_PASSWORD_LENGTH and is used exactly once —
 * to HTTP-Basic-auth the immediate `mintForgejoUserToken` call. It is never
 * stored (the minted token is the persisted credential).
 */
function randomForgejoPassword(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Create a restricted, private Forgejo user via the admin API.
 *
 * Idempotent: a 409/422 (username/email already taken) is treated as
 * "already exists" and we return the existing user via getForgejoUser — but
 * WITHOUT a password (you can't recover an existing user's password). The
 * caller (ensureForgejoIdentity) only mints a token on the fresh-create path,
 * where `password` is returned; the DB identity row is the source of truth for
 * the token thereafter.
 *
 * `restricted:true` is the isolation boundary: the user sees nothing it isn't
 * explicitly made a collaborator on.
 */
export async function createForgejoUser(opts: {
  username: string;
  email: string;
}): Promise<{ user: ForgejoUser; password: string | null; created: boolean }> {
  const password = randomForgejoPassword();
  const res = await fjFetch('/api/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      username: opts.username,
      email: opts.email,
      password,
      must_change_password: false,
      restricted: true,
      visibility: 'private',
    }),
  });
  if (res.status === 409 || res.status === 422) {
    // Already exists — recover the row; password is unknown/unrecoverable.
    const existing = await getForgejoUser(opts.username);
    return { user: existing, password: null, created: false };
  }
  const user = await unwrap<ForgejoUser>(res);
  return { user, password, created: true };
}

/** Look up a Forgejo user by username (admin auth). */
export async function getForgejoUser(username: string): Promise<ForgejoUser> {
  const res = await fjFetch(`/api/v1/users/${encodeURIComponent(username)}`);
  return unwrap<ForgejoUser>(res);
}

/**
 * Delete a Forgejo user via the admin API. Used only to recover the rare
 * "Forgejo user exists but we have NO DB identity row" edge: since the password
 * is unrecoverable we can't mint a token for the orphaned user, so we delete +
 * recreate it cleanly. `purge:true` removes its repos/data too. 404 (already
 * gone) is treated as success.
 */
export async function deleteForgejoUser(username: string): Promise<void> {
  const res = await fjFetch(
    `/api/v1/admin/users/${encodeURIComponent(username)}?purge=true`,
    { method: 'DELETE' }
  );
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`Forgejo deleteUser ${res.status}: ${body.slice(0, 240)}`);
  }
}

/**
 * Mint a fine-grained access token FOR a Forgejo user, authed as that user via
 * HTTP Basic (username:password) — NOT the admin token. gitea/Forgejo's
 * POST /users/{username}/tokens requires the user's own credentials; the admin
 * PAT is rejected here.
 *
 * `scopes` are gitea-1.22 fine-grained scope strings; for repo write the scope
 * is `write:repository` (which implies read). Returns the token's `sha1` — the
 * value the developer uses in the clone URL. The token is shown ONCE by Forgejo
 * (here); we encrypt + persist it immediately.
 */
export async function mintForgejoUserToken(opts: {
  username: string;
  password: string;
  name: string;
  scopes: string[];
}): Promise<string> {
  const basic = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
  const url = `${getBaseUrl()}/api/v1/users/${encodeURIComponent(opts.username)}/tokens`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ name: opts.name, scopes: opts.scopes }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = await unwrap<{ sha1: string }>(res);
  if (!token?.sha1) {
    throw new Error('Forgejo token mint returned no sha1');
  }
  return token.sha1;
}

/**
 * Ensure the `civitai-apps-review` org exists and a per-slug repo under
 * it is ready to receive a commit. Idempotent: both the org POST and the
 * repo POST treat 422 / 409 as "already exists, fine". Returns nothing —
 * the caller proceeds straight to `commitFiles({ org: FORGEJO_REVIEW_ORG })`.
 *
 * Used by the W1 publish-request flow to push the dev's bundle into a
 * disposable review repo at submitVersion time, so /apps/review can
 * deep-link mods into Forgejo's diff view.
 */
export async function ensureReviewRepo(slug: string): Promise<void> {
  // (1) Make sure the org exists. Forgejo accepts org creation via the
  // admin API; 422 means "name taken" (i.e. org already exists).
  const orgRes = await fjFetch('/api/v1/orgs', {
    method: 'POST',
    body: JSON.stringify({
      username: FORGEJO_REVIEW_ORG,
      full_name: 'Civitai App Blocks — in-review',
      description:
        'Disposable per-app repos for the W1 mod-review flow. Overwritten on each submitVersion; not used by the build pipeline.',
      visibility: 'private',
    }),
  });
  if (!orgRes.ok && orgRes.status !== 422 && orgRes.status !== 409) {
    const body = await orgRes.text().catch(() => '');
    throw new Error(`Forgejo org create ${orgRes.status}: ${body.slice(0, 240)}`);
  }
  // (2) Make sure the repo exists. auto_init=true so commitFiles can
  // immediately push to `main` (Forgejo refuses to push to a missing
  // branch). 409 / 422 = already exists.
  //
  // `private: false` is deliberate: the security boundary on
  // forgejo.civitai.com is oauth2-proxy (GH `oauth` team gate), which
  // sits in front of every Forgejo request. Inside that boundary,
  // making review repos public lets mods anonymously browse the file
  // tree from /apps/review's deep-link without needing a separate
  // Forgejo login session (Forgejo's own login form is currently
  // throwing CSRF errors for moderator browsing flows — orthogonal
  // issue, tracked separately).
  const repoRes = await fjFetch(`/api/v1/orgs/${FORGEJO_REVIEW_ORG}/repos`, {
    method: 'POST',
    body: JSON.stringify({
      name: slug,
      description: `Pending publish-request bundle for ${slug}.`,
      private: false,
      auto_init: true,
      default_branch: 'main',
    }),
  });
  if (!repoRes.ok && repoRes.status !== 409 && repoRes.status !== 422) {
    const body = await repoRes.text().catch(() => '');
    throw new Error(`Forgejo review repo create ${repoRes.status}: ${body.slice(0, 240)}`);
  }
}
