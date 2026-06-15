import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import JSZip from 'jszip';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery } from './preview-trpc';

/**
 * Preview-e2e: App Blocks PUBLISH-REQUEST submit leg — proves the developer
 * never authors `iframe.src` and never needs a `Dockerfile` in the bundle.
 *
 * The deterministic DX change under test (see `manifest-normalize.ts`):
 *   - `iframe.src` is PLATFORM-OWNED. A bundle whose manifest OMITS it is
 *     ACCEPTED, and the platform stamps the canonical per-app subdomain root
 *     (`https://<slug>.<APPS_DOMAIN>/`). On origin/main the same bundle was
 *     REJECTED at submit with "manifest.iframe.src must be a string".
 *   - `Dockerfile`/`nginx.conf` are NOT required in the bundle (only
 *     `block.manifest.json` is mandatory); the build pipeline injects its own.
 *
 * Runs as the `mod` fixture (id 2000000001): `/api/blocks/submit-version` is a
 * `ModEndpoint` and `features.appBlocks` (the Flipt mod segment) gates it, so a
 * non-mod would be 401/503 on every call. mod is also rate-limit-exempt.
 *
 * SAFE + SELF-CLEANING (the dev DB + Forgejo are shared across concurrent
 * previews):
 *   - The slug is derived PER-PREVIEW from the preview host (`ci-smoke-pub-
 *     <host-label>`), so two different previews never collide on the partial
 *     unique index `(slug) WHERE status='pending'`. Same-preview re-runs
 *     pre-withdraw any leftover pending row before submitting.
 *   - submit only pushes to the REVIEW org (`civitai-apps-review/<slug>`), which
 *     deliberately has NO build webhook, plus a MinIO object + one dev-DB row —
 *     so it triggers NO Tekton build, NO `civitai-apps` Deployment, NO CF DNS.
 *   - We `withdrawPublishRequest` in `finally` so a mid-test failure still
 *     leaves no pending row and re-runs don't accumulate/collide.
 *
 * --- APPROVE → BUILD → RENDER IS INTENTIONALLY NOT E2E'd HERE -----------------
 * `approveRequest` creates a canonical `civitai-apps/<slug>` Forgejo repo (no
 * cheap teardown without Forgejo admin), fires a real ~5-min Tekton build, an
 * apply Job in the shared prod `civitai-apps` namespace, and a CF DNS record —
 * heavyweight, slow, flaky, and side-effecting on shared infra, the same reason
 * the install spec defers generate/buzz. The approve-side stamping (the
 * committed `block.manifest.json` rewrite + the app_blocks write) and the
 * git-push webhook stamp are covered by the unit suite:
 *   - publish-request.orchestration.test.ts ("stamps the canonical iframe.src
 *     when the manifest omits it" + the happy-path committed/stored-manifest
 *     assertions),
 *   - git-push.gate.test.ts, and
 *   - manifest-normalize.test.ts.
 * The full submit→approve→render path is exercised by the manual preview check
 * in PR #2581. ---------------------------------------------------------------
 *
 * Verified shapes (origin/main, paths relative to civitai/src):
 *  - POST /api/blocks/submit-version (ModEndpoint; body { bundleBase64 }) → 200
 *    `{ publishRequestId, slug, version, bundleSha256, fileSummary,
 *    manifestDiffSummary }` (publish-request.service.ts SubmitVersionResult).
 *    isProd CSRF gate → stamp Origin/Referer (the trpc helper does the same).
 *  - blocks.listPendingRequests (moderatorProcedure + flag; input { limit?,
 *    cursor? }) → `{ items: [{ id, slug, manifest, ... }], nextCursor }`. The
 *    item spreads the row, so `item.manifest` is the stored JSONB manifest.
 *  - blocks.getMyPendingForSlug (moderatorProcedure + flag; input { slug }) →
 *    `{ pending: { id, ... } | null }` — scoped to the caller's own row.
 *  - blocks.withdrawPublishRequest (moderatorProcedure + flag; input
 *    { publishRequestId }) → `{ ok: true }`. Idempotent self-clean.
 */

const ROLE = 'mod' as const;
const PREVIEW_URL = process.env.PREVIEW_URL ?? '';
const APPS_DOMAIN = process.env.APPS_DOMAIN ?? 'civit.ai';
const VERSION = '0.1.0';

// Per-preview slug so concurrent previews don't collide on the pending-per-slug
// unique index. Derive from the preview host's first label (e.g.
// pr-2581.civitaic.com → ci-smoke-pub-pr-2581); sanitize to the slug charset
// (^[a-z][a-z0-9-]*[a-z0-9]$, 3-40 chars).
function previewSlug(): string {
  let label = 'local';
  try {
    label = new URL(PREVIEW_URL).hostname.split('.')[0] || 'local';
  } catch {
    /* fall through to default */
  }
  const sanitized = label.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const slug = `ci-smoke-pub-${sanitized}`.slice(0, 40).replace(/-+$/, '');
  // Guarantee it ends on an alphanumeric (the slug regex requires it).
  return /[a-z0-9]$/.test(slug) ? slug : `${slug}0`;
}

const SLUG = previewSlug();
const CANONICAL_SRC = `https://${SLUG}.${APPS_DOMAIN}/`;

type SubmitResult = { publishRequestId: string; slug: string; version: string };
type PendingItem = { id: string; slug: string; manifest: { iframe?: { src?: string } } };
type PendingList = { items: PendingItem[]; nextCursor: string | null };

// Bundle whose manifest OMITS iframe.src and which contains NO Dockerfile —
// exactly the shape the DX change is meant to accept.
async function buildBundleBase64(): Promise<string> {
  const manifest = {
    blockId: SLUG,
    version: VERSION,
    name: 'CI Smoke — publish DX (omits iframe.src)',
    contentRating: 'g',
    scopes: [] as string[],
    // NOTE: no `src`. minHeight/sandbox stay developer-authored.
    iframe: { minHeight: 300, sandbox: 'allow-scripts allow-forms' },
  };
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('index.html', '<!doctype html><html><body>ci-smoke-pub-dx</body></html>');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf.toString('base64');
}

async function submitBundle(
  request: APIRequestContext,
  bundleBase64: string
): Promise<SubmitResult> {
  const res = await request.post('/api/blocks/submit-version', {
    headers: {
      'content-type': 'application/json',
      origin: PREVIEW_URL,
      referer: `${PREVIEW_URL}/`,
    },
    data: { bundleBase64 },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok()) {
    throw new Error(
      `submit-version -> HTTP ${res.status()}: ${JSON.stringify(body).slice(0, 400)}`
    );
  }
  return body as unknown as SubmitResult;
}

// Find our just-submitted request by slug, paginating the oldest-first queue
// (our row is the newest, so it can be on a later page on a busy clone).
async function findPendingBySlug(
  request: APIRequestContext,
  slug: string
): Promise<PendingItem | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 25; page++) {
    const input: { limit: number; cursor?: string } = { limit: 100 };
    if (cursor) input.cursor = cursor;
    const list: PendingList = await trpcQuery<PendingList>(
      request,
      'blocks.listPendingRequests',
      input
    );
    const hit = list.items.find((i) => i.slug === slug);
    if (hit) return hit;
    if (!list.nextCursor) break;
    cursor = list.nextCursor;
  }
  return null;
}

async function withdrawPendingForSlug(
  request: APIRequestContext,
  slug: string
): Promise<void> {
  const r = await trpcQuery<{ pending: { id: string } | null }>(
    request,
    'blocks.getMyPendingForSlug',
    { slug }
  ).catch(() => ({ pending: null }));
  if (r?.pending?.id) {
    await trpcMutation(request, 'blocks.withdrawPublishRequest', {
      publishRequestId: r.pending.id,
    }).catch(() => {});
  }
}

test.describe('App Blocks publish-request: iframe.src is platform-stamped (mod, self-cleaning)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('submit a bundle that omits iframe.src + has no Dockerfile → accepted, canonical src stamped', async ({
    page,
  }) => {
    // Warm page.request against the preview origin (shares the mod auth cookie;
    // the helpers stamp Origin/Referer for the CSRF gate). domcontentloaded ONLY.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const request = page.request;

    // Pre-clean any leftover pending row for this preview's slug (prior crashed run).
    await withdrawPendingForSlug(request, SLUG);

    let publishRequestId: string | null = null;
    try {
      const bundleBase64 = await buildBundleBase64();

      // SUBMIT — on origin/main this 400s with "manifest.iframe.src must be a
      // string"; with the DX change the platform derives + stamps it, so the
      // submit (a manifest with no iframe.src, a bundle with no Dockerfile) is
      // accepted. The 200 itself is the first half of the proof.
      const result = await submitBundle(request, bundleBase64);
      publishRequestId = result.publishRequestId;
      expect(typeof result.publishRequestId, 'submit returns a publishRequestId').toBe('string');
      expect(result.slug, 'slug is taken from manifest.blockId').toBe(SLUG);

      // READ-BACK via the mod queue: the STORED manifest carries the canonical
      // per-app subdomain root even though the uploaded bundle never declared
      // iframe.src. This is the second half of the proof.
      const item = await findPendingBySlug(request, SLUG);
      expect(item, 'the submitted request should appear in the pending queue').not.toBeNull();
      expect(
        item!.manifest?.iframe?.src,
        'iframe.src is server-stamped to the canonical per-app subdomain root'
      ).toBe(CANONICAL_SRC);
    } finally {
      // SELF-CLEAN: withdraw so no pending row lingers and re-runs don't collide.
      if (publishRequestId) {
        await trpcMutation(request, 'blocks.withdrawPublishRequest', {
          publishRequestId,
        }).catch(() => {});
      } else {
        await withdrawPendingForSlug(request, SLUG);
      }
    }
  });
});
