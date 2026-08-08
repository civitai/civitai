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
import { logToAxiom } from '~/server/logging/client';
import { MAX_FILES_IN_BUNDLE } from '~/server/schema/blocks/publish-request.schema';

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

/**
 * Browser deep-link to the CANONICAL app repo at an exact commit. Used by the
 * mod-review UI for PUSH-ORIGINATED requests: those have no uploaded bundle and
 * no civitai-apps-review snapshot — the canonical `civitai-apps/<slug>` repo at
 * the pushed sha IS the reviewable artifact. Uses FORGEJO_PUBLIC_URL
 * (browser-facing host), mirroring reviewRepoUrl.
 */
export function repoCommitUrl(slug: string, ref: string): string {
  const u = env.FORGEJO_PUBLIC_URL.replace(/\/$/, '');
  return `${u}/${FORGEJO_ORG}/${slug}/src/commit/${ref}`;
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

/** Default client-side abort for cheap Forgejo metadata calls. Forgejo API
 *  calls should be sub-second; anything longer indicates an in-cluster
 *  reachability problem worth surfacing fast. Tunable via FORGEJO_API_TIMEOUT_MS. */
function apiTimeoutMs(): number {
  return env.FORGEJO_API_TIMEOUT_MS;
}

/** Generous client-side abort for the bundle COMMIT/PUSH path (first-time
 *  review-repo create + a single multi-file commit of every bundle file). A
 *  real app (gen-matrix = ~888 files) genuinely takes longer than the cheap
 *  metadata calls; the old 15s ceiling aborted real submits. Tunable via
 *  FORGEJO_COMMIT_TIMEOUT_MS. */
function commitTimeoutMs(): number {
  return env.FORGEJO_COMMIT_TIMEOUT_MS;
}

async function fjFetch(
  path: string,
  init?: RequestInit,
  timeoutMs: number = apiTimeoutMs()
): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...buildHeaders(), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
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

  // Repo creation (template `generate` clones the starter repo; `auto_init`
  // materialises an initial commit) is the slow first-time op on the approve
  // path, so give it the generous commit timeout rather than the cheap-call
  // ceiling. The idempotent 409/422 → getRepo lookup stays a cheap call.
  const res = await fjFetch(
    endpoint,
    { method: 'POST', body: JSON.stringify(body) },
    commitTimeoutMs()
  );
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

/**
 * Collaborator access levels, LOW → HIGH. This ordering is what makes
 * `addCollaborator` a GRANT-AT-LEAST rather than a SET: a caller asking for a
 * level at or below what the user already holds is a no-op, never a downgrade.
 *
 * Every string here was MEASURED against Forgejo `15.0.6+gitea-1.22.0` — the
 * version `GET /api/v1/version` reports for the deployed instance — as a value
 * `GET …/collaborators/{user}/permission` actually returns:
 *   - `none`  is what a NON-collaborator reads back **on a PRIVATE repo**. That
 *             endpoint answers 200 with `permission: "none"`, NOT 404, so "not
 *             a collaborator yet" is an ordinary reading, not an error.
 *             🔴 On a PUBLIC repo the same read answers `"read"` instead
 *             (measured), because everyone can read it. Canonical app repos are
 *             created `private: true` (`createRepoFromTemplate`, above), so this
 *             is not live today — but this file already records one visibility
 *             regression (the `#3498` note on the review-repo helpers below), and
 *             if a canonical repo ever went public the CLI-pull `read` grant
 *             would rank as already-satisfied and become a permanent no-op, so
 *             no collaborator row would ever be created.
 *   - `owner` is what an org owner reads back. Adding an org owner as a
 *             collaborator creates a row but still reads `owner` (measured), so
 *             the short-circuit below is correct for them.
 * Only `read` / `write` / `admin` are grantable by PUT: a PUT of `owner`
 * answers 204 and changes nothing, and the match is case-SENSITIVE — an
 * uppercase `WRITE` from a `read` baseline is a 204 no-op (measured).
 */
const COLLABORATOR_PERMISSION_RANK = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
  owner: 4,
} as const;

export type CollaboratorPermission = keyof typeof COLLABORATOR_PERMISSION_RANK;
export type GrantablePermission = 'read' | 'write' | 'admin';

function permissionRank(value: string): number | null {
  return Object.prototype.hasOwnProperty.call(COLLABORATOR_PERMISSION_RANK, value)
    ? COLLABORATOR_PERMISSION_RANK[value as CollaboratorPermission]
    : null;
}

/**
 * Three-valued on purpose — but for OBSERVABILITY, not correctness. Be precise
 * about this, because the obvious stronger claim is false and a maintainer who
 * tests it will (correctly) conclude the distinction is dead weight and delete
 * it.
 *
 * What it does NOT buy: collapsing `unknown` or `unreadable` into `none` would
 * NOT change one byte of HTTP. Both already fall through to the PUT — that is
 * the fail-toward-access design below — and rank 0 falls through too, so the
 * requests sent and the resulting permission are identical either way. Measured:
 * with both collapses applied, the outgoing URLs, methods and bodies and the
 * final permission are byte-identical to HEAD.
 *
 * What it DOES buy: `none` is a MEASUREMENT ("we asked; they hold nothing")
 * while the other two are the ABSENCE of one. Only the distinction lets the
 * warning below fire, and that warning is the sole signal that a grant went out
 * blind. Fold them together and blind grants become indistinguishable from
 * observed ones — a fabricated zero of exactly the kind this codebase keeps
 * paying for elsewhere.
 */
type PermissionRead =
  | { kind: 'known'; permission: CollaboratorPermission }
  | { kind: 'unknown'; raw: string }
  | { kind: 'unreadable'; reason: string };

async function readCollaboratorPermission(slug: string, username: string): Promise<PermissionRead> {
  try {
    const res = await fjFetch(
      `/api/v1/repos/${FORGEJO_ORG}/${slug}/collaborators/${encodeURIComponent(
        username
      )}/permission`
    );
    if (!res.ok) {
      // 404 here means the USER or the REPO does not exist (measured) — never
      // "is not a collaborator", which reads back 200 + `none`. Either way we
      // cannot rank what we did not read.
      return { kind: 'unreadable', reason: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as { permission?: unknown } | null;
    const raw = body?.permission;
    if (typeof raw !== 'string') return { kind: 'unreadable', reason: 'no permission field' };
    if (permissionRank(raw) === null) return { kind: 'unknown', raw };
    return { kind: 'known', permission: raw as CollaboratorPermission };
  } catch (error) {
    return { kind: 'unreadable', reason: (error as Error)?.message ?? 'read threw' };
  }
}

export type AddCollaboratorResult = {
  requested: GrantablePermission;
  /** What we read before deciding, or null when the read was unobservable. */
  existing: CollaboratorPermission | null;
  /**
   * `kept`   — already at or above `requested`; no PUT was sent.
   * `granted` — the read succeeded and `requested` was strictly higher.
   * `granted-unobserved` — the read failed or returned an unrankable string, so
   *   the grant went out WITHOUT knowing whether it lowers anything.
   */
  outcome: 'kept' | 'granted' | 'granted-unobserved';
};

/**
 * Grant a Forgejo username AT LEAST `permission` on the repo — never less.
 *
 * The bare PUT this replaced was a SET, not a grant: Forgejo applies whatever
 * level the body names, in both directions. Measured on 15.0.6+gitea-1.22.0,
 * every one of first-grant / same-level re-grant / upgrade / DOWNGRADE answers
 * `204 No Content` with an empty body, and a read-back confirms the downgrade
 * landed. So `civitai app pull` (which asks for `read`) silently stripped push
 * access from an author who had `write` from the web flow, and no status code
 * distinguished that from success.
 *
 * The downgrade was not cosmetic. Measured with a `write:repository` PAT — the
 * exact scope `dev-git-access.service.ts` mints — against a private repo:
 * no collaborator row → `git clone` FAILS (`Repository not found`); `read` →
 * clone succeeds but `git push` is REJECTED (`not allowed to push to branch
 * 'main'`); `write` → both succeed. So the read/write split between the two call
 * sites buys real least-privilege rather than being decorative, and the bug it
 * enabled genuinely broke authors' pushes.
 *
 * Read-before-write closes it: rank the current level, and skip the PUT whenever
 * it is already at or above what the caller asked for. `admin` and `owner` are
 * therefore unreachable by either call site.
 *
 * 🔴 NOT ATOMIC. Forgejo offers no compare-and-set here, so the read and the
 * write are two round trips, and the two procedures that call this run on
 * separate connections. A concurrent web call and CLI call can interleave —
 * both read `none`, the web one PUTs `write`, the CLI one then PUTs `read` —
 * reproducing the original downgrade inside a one-round-trip window. That
 * window is strictly narrower than the unconditional overwrite this replaced,
 * so it is an improvement rather than a regression, but "never lowers" above is
 * a claim about the SEQUENTIAL case. Closing it needs a lock or a server-side
 * CAS.
 *
 * WHEN THE READ IS UNOBSERVABLE we still send the grant (`granted-unobserved`)
 * and log it. Why proceeding beats skipping: both failure modes are real —
 * skipping denies access, and the denial is total (measured above: with no
 * collaborator row the clone fails outright) — but a denial is LOUD and
 * SELF-HEALING, since the read failure is transient by hypothesis and both call
 * sites re-run on the user's next attempt, whereas a downgrade is SILENT and
 * PERSISTENT, sticking until someone notices they can no longer push. Prefer
 * the failure the user can see and retry past.
 *
 * A third option was considered and REJECTED: on an unobservable read, grant
 * `write` (the ceiling `getMyAppRepo` already asks for) instead of the requested
 * level. It does not do what it promises. It still downgrades an existing
 * `admin` — measured, `admin` → `write` answers 204 and lowers — so it narrows
 * the window rather than closing it, and it pays for that by silently and
 * PERMANENTLY handing push access to a CLI-pull caller who asked only for
 * `read`, triggered by an infrastructure hiccup. Trading a silent persistent
 * downgrade for a silent persistent ESCALATION is not an improvement; it is the
 * same bug mirrored.
 */
export async function addCollaborator(opts: {
  slug: string;
  username: string;
  permission?: GrantablePermission;
}): Promise<AddCollaboratorResult> {
  const requested = opts.permission ?? 'write';
  const requestedRank = COLLABORATOR_PERMISSION_RANK[requested];

  const current = await readCollaboratorPermission(opts.slug, opts.username);

  if (current.kind === 'known') {
    const currentRank = COLLABORATOR_PERMISSION_RANK[current.permission];
    if (currentRank >= requestedRank) {
      if (currentRank > requestedRank) {
        // A downgrade we actively refused. Logged because it is the ONLY
        // evidence in production that the guard fires at all.
        logToAxiom(
          {
            name: 'forgejo-add-collaborator',
            type: 'info',
            message: 'kept higher existing permission',
            slug: opts.slug,
            username: opts.username,
            requested,
            existing: current.permission,
          },
          'webhooks'
        ).catch(() => undefined);
      }
      return { requested, existing: current.permission, outcome: 'kept' };
    }
  } else {
    // The blind-grant signal. Honest about its reach: nothing consumes
    // `forgejo-add-collaborator` today — no alert, no dashboard, no saved query
    // — and `logToAxiom` here is fire-and-forget (unawaited, errors swallowed),
    // so a logging outage drops it without a trace. It makes a blind grant
    // DISCOVERABLE by someone who goes looking; it does not make anyone look.
    // If this path ever matters operationally, wire an alert on this name — do
    // not assume emitting the event is the same as being told.
    logToAxiom(
      {
        name: 'forgejo-add-collaborator',
        type: 'warning',
        message: 'granting without observing the current permission',
        slug: opts.slug,
        username: opts.username,
        requested,
        reason: current.kind === 'unknown' ? `unrankable "${current.raw}"` : current.reason,
      },
      'webhooks'
    ).catch(() => undefined);
  }

  const res = await fjFetch(
    `/api/v1/repos/${FORGEJO_ORG}/${opts.slug}/collaborators/${encodeURIComponent(opts.username)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ permission: requested }),
    }
  );
  // Measured: 204 No Content for first grant, same-level re-grant, upgrade AND
  // downgrade alike. The 422 tolerance predates this change and is kept as a
  // defensive allowance only — the "already a collaborator at the same level"
  // explanation it used to carry was measured FALSE (that case is a 204).
  if (!res.ok && res.status !== 422) {
    const body = await res.text().catch(() => '');
    throw new Error(`Forgejo addCollaborator ${res.status}: ${body.slice(0, 240)}`);
  }
  return {
    requested,
    existing: current.kind === 'known' ? current.permission : null,
    outcome: current.kind === 'known' ? 'granted' : 'granted-unobserved',
  };
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
    signal: AbortSignal.timeout(apiTimeoutMs()),
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
 *
 * Delegates the tree read to `listRepoTreeAtRef`, so it inherits that
 * function's pagination over trees larger than one page.
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
 * Page size for the recursive tree listing. 1000 is the API's own ceiling
 * for this endpoint (a larger `per_page` is silently clamped down to it), so
 * this is the fewest round-trips a full tree read can cost.
 */
const TREE_PAGE_SIZE = 1000;

/**
 * Size bound for the tree pager — the most entries we are willing to read
 * before giving up, derived from the submit-time file cap rather than a magic
 * number. A tree listing returns a directory entry per folder on top of one
 * entry per file, so allow headroom over MAX_FILES_IN_BUNDLE; a well-formed
 * app stops long before this.
 *
 * This bounds TREE SIZE. It is not the anti-infinite-loop backstop (that is
 * MAX_TREE_REQUESTS below), and it is not the file limit the caller cares
 * about (that is MAX_FILES_IN_BUNDLE, applied to blobs at the end) — the three
 * bounds are deliberately distinct.
 */
const MAX_TREE_ENTRIES = MAX_FILES_IN_BUNDLE * 4;

/**
 * Anti-infinite-loop backstop on the number of REQUESTS, which is a separate
 * bound from MAX_TREE_ENTRIES (the bound on entries actually read).
 *
 * 🔴 They must stay separate. Deriving this from MAX_TREE_ENTRIES /
 * TREE_PAGE_SIZE would assume the host honours the `per_page` we ask for —
 * precisely the assumption the stop condition below deliberately refuses to
 * make. A host that clamped `per_page` to 100 would exhaust an 8-request
 * budget after only 800 entries and then reject a perfectly legal 1500-entry
 * tree for "exceeding 8000 entries": a false ceiling an order of magnitude
 * below the real one. Sizing the request budget well above
 * MAX_TREE_ENTRIES / TREE_PAGE_SIZE keeps a full-size tree readable even when
 * the host serves it in much smaller pages, while still bounding the walk.
 */
const MAX_TREE_REQUESTS = 64;

/**
 * Recursively list every blob in the repo at an arbitrary git ref —
 * a commit SHA (NOT just a branch name) — as Map<path, blob-sha>. Same
 * shape as `listRepoTree`, but skips the branch→commit lookup so the
 * caller can snapshot a specific historical commit (e.g. the sha a
 * git-push parked on a pending review request).
 *
 * Forgejo's `git/trees/<ref>` resolves a commit ref to its root tree, so
 * passing a commit SHA returns that commit's full recursive blob list.
 *
 * 🔴 PAGINATED. The endpoint caps a single response at TREE_PAGE_SIZE entries
 * and flags the overflow with `truncated`, while submit-time validation accepts
 * up to MAX_FILES_IN_BUNDLE (2000) files — so an app between 1001 and 2000
 * files produces a tree this function MUST page through. It used to throw on
 * `truncated` instead, which made such an app impossible to approve, diff or
 * preview once accepted.
 *
 * Stop condition, in priority order — deliberately NOT "a short page means the
 * last page", because the server is free to clamp `per_page` below what we ask
 * for, which would make the very first page look short and end the walk early:
 *   1. an empty page      → nothing left;
 *   2. an exactly-FULL page → always probe once more. A page that filled to the
 *                       requested size is the one case where "there is more"
 *                       needs no corroboration from the host's own metadata,
 *                       so this costs nothing and removes the only branch that
 *                       could silently under-read (a `total_count` that
 *                       under-reports, or a response carrying neither
 *                       `total_count` nor `truncated`);
 *   3. `total_count`      → authoritative entry total; stop once we have seen it
 *                       all (saves the trailing empty-page round-trip — but only
 *                       when the final page came back PARTIAL, which is the
 *                       normal case; a tree whose size is an exact multiple of
 *                       the page size still pays one confirming probe, per (2));
 *   4. `truncated`        → fallback for a response without `total_count`: keep
 *                       paging while the flag says the tree overflows a page.
 *
 * 🔴 An empty response BODY is not a stop condition — it is an error. `unwrap`
 * returns null for one, which is a different thing from an envelope carrying a
 * null `tree` (the host's legitimate past-the-end marker). Collapsing the two
 * would let a 204, a truncated body or a gateway artifact mid-walk return a
 * SILENTLY PARTIAL tree, and every caller treats what it gets back as the
 * complete tree: `reconstructBundleFromForgejo` would make an incomplete bundle
 * the approved artifact (with a bundleSha256 over the partial set), and
 * `commitFiles(replaceAllFiles: true)` would emit deletes only for the paths it
 * managed to read, silently leaving stale files behind.
 */
export async function listRepoTreeAtRef(
  slug: string,
  ref: string,
  org: string = FORGEJO_ORG
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let seen = 0;
  let complete = false;

  for (let page = 1; seen < MAX_TREE_ENTRIES && page <= MAX_TREE_REQUESTS; page++) {
    const treeRes = await fjFetch(
      `/api/v1/repos/${org}/${slug}/git/trees/${encodeURIComponent(
        ref
      )}?recursive=true&per_page=${TREE_PAGE_SIZE}&page=${page}`
    );
    const tree = await unwrap<{
      // Past the end of the tree the API answers with a null/absent list, so
      // this is not guaranteed to be an array.
      tree?: Array<{ path: string; type: string; sha: string }> | null;
      truncated?: boolean;
      total_count?: number;
    } | null>(treeRes);

    // No envelope at all — an empty body, not a past-the-end marker. Refuse to
    // pass off however much we happened to read as the complete tree.
    if (tree == null)
      throw new Error(
        `Forgejo tree for ${slug}@${ref}: empty response body on page ${page} after ` +
          `${seen} entries — refusing to treat a partial tree as complete`
      );

    const entries = tree.tree ?? [];
    for (const item of entries) {
      if (item.type === 'blob') result.set(item.path, item.sha);
    }
    seen += entries.length;

    if (entries.length === 0) {
      complete = true;
      break;
    }
    // An exactly-full page always warrants one more probe, whatever the host's
    // metadata claims. This cannot resurrect the short-page bug guarded against
    // above (it only ever continues, never stops), and stays inside the loop
    // bounds.
    if (entries.length >= TREE_PAGE_SIZE) continue;

    const total = typeof tree.total_count === 'number' ? tree.total_count : undefined;
    if (total !== undefined && total > 0) {
      if (seen >= total) {
        complete = true;
        break;
      }
    } else if (tree.truncated !== true) {
      complete = true;
      break;
    }
  }

  // Name the bound that actually tripped: "too big" and "the host is paginating
  // in unexpectedly small pages" are different operator problems.
  if (!complete) {
    if (seen >= MAX_TREE_ENTRIES)
      throw new Error(
        `Forgejo tree for ${slug}@${ref} exceeds ${MAX_TREE_ENTRIES} entries; an app may contain ` +
          `at most ${MAX_FILES_IN_BUNDLE} files — reduce the file count and re-submit`
      );
    throw new Error(
      `Forgejo tree for ${slug}@${ref} did not finish within ${MAX_TREE_REQUESTS} requests ` +
        `(${seen} entries read); the source host is paginating in unexpectedly small pages`
    );
  }

  // 🔴 Bound the quantity the caller actually cares about. MAX_TREE_ENTRIES
  // bounds tree ENTRIES (blobs + directories) as a loop guard; nothing above
  // bounds BLOBS, so without this a repo could hand back several thousand files
  // from a function whose limit error promises at most MAX_FILES_IN_BUNDLE.
  //
  // This is a real gate, not just an honest message. On the git-push path
  // MAX_FILES_IN_BUNDLE is otherwise unenforced: `enrichPushRequestRow` wraps
  // the cap-applying diff computation in a catch that only logs (the row still
  // parks as pending), and the approve path's bundle extraction caps total
  // bytes but not file count. Before this function paged, its `truncated` throw
  // was incidentally enforcing a ceiling here; keeping an explicit one means
  // paging did not quietly raise it. Every caller is app-repo-scoped — the
  // canonical `civitai-apps/<slug>` or its review mirror, whose contents ARE
  // the bundle — so none legitimately needs more than this.
  if (result.size > MAX_FILES_IN_BUNDLE)
    throw new Error(
      `Forgejo tree for ${slug}@${ref} holds ${result.size} files; an app may contain at most ` +
        `${MAX_FILES_IN_BUNDLE} — reduce the file count and re-submit`
    );

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
    throw new Error(`Forgejo blob ${sha} returned unexpected encoding ${blob.encoding}`);
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
 *
 * 🔴 NOT content-comparing, and therefore NOT idempotent. An existing
 * path always gets an `update` op regardless of whether its bytes
 * changed, so calling this twice with an IDENTICAL file set still
 * produces a second commit with a new sha. A caller that needs a stable
 * sha across repeat calls (e.g. the review-preview mirror) must compare
 * the tree itself and skip the call — see `reviewRepoAlreadyHoldsTree`
 * in publish-request.service.
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
    // Reached ONLY when `files` is empty and there is nothing to delete —
    // NOT when the bundle merely matches the repo state (an unchanged path
    // still emits an `update` op above). Return the current HEAD SHA so the
    // publish_request still gets a forgejo_commit_sha pointer.
    const branchRes = await fjFetch(
      `/api/v1/repos/${org}/${opts.slug}/branches/${encodeURIComponent(branch)}`
    );
    const branchInfo = await unwrap<{ commit: { id: string } }>(branchRes);
    return { sha: branchInfo.commit.id };
  }

  // The multi-file commit is the genuinely slow Forgejo call — a real bundle
  // (gen-matrix = ~888 files) takes well over the cheap-call ceiling, so give
  // it the generous commit timeout instead of letting AbortSignal kill the
  // push mid-flight ("The operation was aborted due to timeout").
  const res = await fjFetch(
    `/api/v1/repos/${org}/${opts.slug}/contents`,
    {
      method: 'POST',
      body: JSON.stringify({
        files: operations,
        message: opts.message,
        branch,
      }),
    },
    commitTimeoutMs()
  );
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
  const res = await fjFetch(`/api/v1/admin/users/${encodeURIComponent(username)}?purge=true`, {
    method: 'DELETE',
  });
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
    signal: AbortSignal.timeout(apiTimeoutMs()),
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
  // 🔴 `private: true` is load-bearing, NOT a default. These snapshots hold the
  // FULL SOURCE of a third-party submission that has NOT been approved yet —
  // unreviewed code belonging to someone else, keyed by a guessable app slug.
  // Nothing needs anonymous read to make the product work: the review build
  // authenticates to the review source host with its own credential, and mods
  // read the submission through the in-app diff in the review modal rather than
  // by browsing the raw repo. So `private` costs us nothing and is the only
  // control that holds no matter how the request reaches the host.
  //
  // This was `private: false` until #3498. That flag leaned on an
  // authentication layer sitting in front of every request to the review source
  // host — true when it was written, no longer true after that host's routing
  // was later changed for an unrelated reason. Two individually-reasonable
  // changes composed into anonymous public read of unapproved third-party
  // source. DO NOT flip this back to `false` for browsing convenience: the repo
  // itself must be the boundary, so that no future routing/auth change upstream
  // can silently re-open it.
  //
  // auto_init:true makes Forgejo materialise a real git repo on disk, which on
  // first submit is the slow part of the review-repo path (it shares the same
  // worst-case as the bundle commit). Use the generous commit timeout so a
  // cold first-time create doesn't abort before the repo is ready.
  const repoRes = await fjFetch(
    `/api/v1/orgs/${FORGEJO_REVIEW_ORG}/repos`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: slug,
        description: `Pending publish-request bundle for ${slug}.`,
        private: true,
        auto_init: true,
        default_branch: 'main',
      }),
    },
    commitTimeoutMs()
  );
  if (!repoRes.ok && repoRes.status !== 409 && repoRes.status !== 422) {
    const body = await repoRes.text().catch(() => '');
    throw new Error(`Forgejo review repo create ${repoRes.status}: ${body.slice(0, 240)}`);
  }
}

/**
 * Page through every repo in the in-review org. Used by the one-off privacy
 * backfill to enumerate snapshots created BEFORE `ensureReviewRepo` started
 * setting `private: true` — the create call is idempotent on an existing repo,
 * so a re-submit does NOT retroactively flip an old repo's visibility.
 *
 * Bounded: stops at `maxPages` so a runaway/looping pager can never spin
 * forever against the API.
 */
export async function listReviewRepos(
  opts: { perPage?: number; maxPages?: number } = {}
): Promise<Array<{ name: string; private: boolean }>> {
  const perPage = opts.perPage ?? 50;
  const maxPages = opts.maxPages ?? 100;
  const out: Array<{ name: string; private: boolean }> = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fjFetch(
      `/api/v1/orgs/${FORGEJO_REVIEW_ORG}/repos?page=${page}&limit=${perPage}`
    );
    // 404 = the org has never been created (no submissions yet) — an empty
    // result, not an error. Anything else non-2xx is a real failure.
    if (res.status === 404) return out;
    const rows = await unwrap<Array<{ name: string; private: boolean }>>(res);
    if (!rows || rows.length === 0) return out;
    for (const r of rows) out.push({ name: r.name, private: !!r.private });
    if (rows.length < perPage) return out;
  }
  return out;
}

/**
 * Flip an in-review snapshot repo to private. Idempotent — Forgejo accepts a
 * PATCH that sets `private: true` on an already-private repo, and a 404 (repo
 * gone) is reported as `missing` rather than thrown, so the backfill can be
 * re-run safely at any time.
 *
 * Scoped to the in-review org on purpose: nothing here should ever be able to
 * mutate the visibility of a canonical `civitai-apps/<slug>` repo.
 */
export async function setReviewRepoPrivate(slug: string): Promise<'updated' | 'missing'> {
  const res = await fjFetch(`/api/v1/repos/${FORGEJO_REVIEW_ORG}/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    body: JSON.stringify({ private: true }),
  });
  if (res.status === 404) return 'missing';
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Forgejo review repo patch ${res.status}: ${body.slice(0, 240)}`);
  }
  return 'updated';
}

/**
 * Delete an in-review snapshot repo. Idempotent: a 404 (already gone) is
 * SUCCESS, reported as `already-gone` so a caller can distinguish "I reclaimed
 * something" from "there was nothing to reclaim" without either being an error.
 *
 * Deliberately scoped to the in-review org — this function cannot be pointed at
 * `civitai-apps/<slug>`, which is the system of record for a pushed app. The
 * in-review repo is a DERIVED CACHE: a ZIP submission's bundle lives in object
 * storage under `bundleKey`, and a push submission's source lives in the
 * canonical repo at the pinned `forgejoCommitSha`. Purging a snapshot therefore
 * loses nothing that cannot be rebuilt.
 */
export async function deleteReviewRepo(slug: string): Promise<'deleted' | 'already-gone'> {
  const res = await fjFetch(`/api/v1/repos/${FORGEJO_REVIEW_ORG}/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  });
  if (res.status === 404) return 'already-gone';
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`Forgejo review repo delete ${res.status}: ${body.slice(0, 240)}`);
  }
  return 'deleted';
}

/**
 * MOD REVIEW SANDBOX (#2831) — current HEAD commit sha of the in-review repo
 * `civitai-apps-review/<slug>` on `main`. Full 40-hex sha (the build pipeline
 * requires it).
 *
 * 🔴 HEAD is the pending version's source ONLY for a ZIP-originated request:
 * submitVersion pushes that bundle here (replaceAllFiles=true) and at most one
 * request is pending per slug. A request that arrived by `git push` never wrote
 * here — for those, HEAD is an OLDER submission's tree (or missing entirely), so
 * calling this for one previews the wrong code. `previewRequest` discriminates
 * on the request's origin before it gets here (resolveReviewSourceSha); do not
 * call this without doing the same.
 */
export async function getReviewRepoHeadSha(slug: string): Promise<string> {
  const res = await fjFetch(
    `/api/v1/repos/${FORGEJO_REVIEW_ORG}/${slug}/branches/${encodeURIComponent('main')}`
  );
  const branch = await unwrap<{ commit: { id: string } }>(res);
  if (!branch?.commit?.id) {
    throw new Error(`in-review repo ${FORGEJO_REVIEW_ORG}/${slug} has no main HEAD`);
  }
  return branch.commit.id;
}
