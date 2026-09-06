import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';

/**
 * BLOCK_INIT v2 contract — the W10 FULL-PAGE host (`app.page`).
 *
 * 🔴 THIS IS THE HALF OF THE COVERAGE A SINGLE-SURFACE SUITE STRUCTURALLY
 * CANNOT SEE, and the seam is real rather than hypothetical: this host does NOT
 * call `projectBlockInitViewer` at all. It receives an already-resolved `viewer`
 * PROP from the /apps/run/[slug] route and used to pass it into BLOCK_INIT
 * untouched — so the v2 `signedIn` flag, added inside that projection, reached
 * the model-slot surface only and EVERY full-page app would have shipped a
 * viewer object without it. The fix routes both hosts through the shared
 * `withSignedInFlag` helper; this file pins that THIS host goes through it.
 *
 * The same duplication applies to the `TOKEN_REFRESH_RESPONSE.requestId`
 * contract below — the two hosts register their postMessage handlers by hand and
 * share no bridge, so a fix to one does not reach the other.
 *
 * Mocks mirror `PageBlockHostTokenTerminal.browser.test.tsx` (the page-host
 * scaffold): only the ambient tRPC client and useCurrentUser are stubbed.
 */

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically
  // imports `setTrpcBatchingEnabled` from this module (#2946). vi.mock replaces
  // the module wholesale, so the factory must re-declare it or the ESM link
  // fails.
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        report: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
      storage: {
        set: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        delete: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
    },
    useUtils: () => ({
      apps: {
        shared: {
          list: { fetch: vi.fn() },
          getCount: { fetch: vi.fn() },
          getCounts: { fetch: vi.fn() },
          get: { fetch: vi.fn() },
        },
        storage: {
          get: { fetch: vi.fn() },
          list: { fetch: vi.fn() },
          getQuota: { fetch: vi.fn() },
        },
      },
    }),
  },
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
// eslint-disable-next-line import/first
import type { BlockInitPayload } from '~/components/AppBlocks/types';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

function iframeEl() {
  return page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
}

function postFromBlock(type: string, payload?: unknown) {
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

/** Capture host→block posts. `send` targets the iframe's contentWindow. */
function listenForHostPosts() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    received,
    of: (type: string) => received.filter((m) => m.type === type),
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

/**
 * Fixture values are NON-DEFAULT and pairwise distinct, and deliberately share NO
 * value with the model-slot mirror of this file — so no assertion can pass by two
 * fields collapsing onto the same value, and a cross-host copy-paste cannot pass
 * against the wrong host's data.
 *
 * TWO DELIBERATE EXCEPTIONS, both mirroring a real production identity rather
 * than sloppiness — do not "fix" them by inventing distinct values, that would
 * make the fixture LESS faithful than the route it stands in for:
 *
 *   - `slug` === `blockId`. `/apps/run/[slug]/[[...path]].tsx` builds its props
 *     with `slug: page.blockId` — the AppBlock's `block_id` IS the slug (it is
 *     what builds `<slug>.civit.ai`). They are one value in prod, so a
 *     "transposition" of the two is not a defect that can exist.
 *   - `blockInstanceId` embeds `appBlockId` (`page_<appBlockId>`), which is how
 *     the route derives it. The blockId/appId/blockInstanceId assertions below
 *     stay meaningful because those three ARE mutually distinct.
 */
const baseProps = {
  appBlockId: 'apb_sandpiper_5527',
  blockId: 'lanternfish-studio',
  appId: 'app_peridot_7064',
  blockInstanceId: 'page_apb_sandpiper_5527',
  appName: 'Lanternfish Studio',
  iframeSrc: SAME_ORIGIN_SRC,
  // The public run surface. Required since the init-fragment gate keys on it.
  surface: 'page-run' as const,
  // Required. These suites cover the DEFAULT (host-veil) presentation;
  // the bootSkeleton path is covered in PageBlockHostLaunchReveal.
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'lanternfish-studio',
  token: 'tok_saffron_1938',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['apps:storage:read'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 8472, username: 'nimbus-drake' } as { id: number; username: string | null } | null,
  theme: 'light' as const,
};

/**
 * Mount, attach the host→block listener, and wait until it has OBSERVED a real
 * BLOCK_INIT.
 *
 * That wait is the positive control for every assertion in this file: a
 * `toHaveLength(0)` read off a listener wired to nothing is indistinguishable
 * from a genuine zero, so nothing is asserted until the channel has been proven
 * to carry traffic.
 */
async function mountAndCaptureInit(overrides: Partial<typeof baseProps> = {}) {
  await renderWithProviders(
    <PageBlockHost
      {...baseProps}
      {...overrides}
      onConsentGranted={vi.fn()}
      onRetryToken={vi.fn()}
    />
  );
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  const posts = listenForHostPosts();
  await vi.waitFor(() => {
    if (posts.of('BLOCK_INIT').length === 0) throw new Error('listener saw no BLOCK_INIT');
  });
  const init = posts.last('BLOCK_INIT')!.payload as BlockInitPayload;
  return { posts, init };
}

describe('PageBlockHost BLOCK_INIT — viewer.signedIn (v2)', () => {
  test('🔴 signedIn: true reaches the block through the PROP path, not the projection', async () => {
    // The seam. This host never calls `projectBlockInitViewer`, so a flag added
    // there alone would leave this assertion red while the model-slot suite
    // stayed green — a defect visible only from BOTH surfaces at once.
    const { posts, init } = await mountAndCaptureInit();
    expect(init.viewer?.signedIn).toBe(true);
    posts.stop();
  });

  test('the deprecated id/username still ride along, correct and un-swapped', async () => {
    const { posts, init } = await mountAndCaptureInit();
    // Deprecated (unconditional identity disclosure; `GET_VIEWER` is the
    // replacement) but NOT removable: the `isValidBlockInitPayload` guard
    // compiled into every deployed bundle rejects a viewer without a numeric
    // `id`, and 5 of the 9 currently-approved apps read it for
    // ownership/authorship logic.
    expect(init.viewer?.id).toBe(8472);
    expect(init.viewer?.username).toBe('nimbus-drake');
    posts.stop();
  });

  test('the viewer object carries EXACTLY id + username + signedIn', async () => {
    const { posts, init } = await mountAndCaptureInit();
    expect(Object.keys(init.viewer ?? {}).sort()).toEqual(['id', 'signedIn', 'username']);
    posts.stop();
  });

  test('🔴 an anonymous viewer is NULL — never an object with signedIn: false', async () => {
    // The wire shape is frozen at `object-or-null` by the deployed guard, which
    // accepts only `null` or an object with a NUMERIC `id`. An anonymous viewer
    // rendered as `{ signedIn: false }` would fail that guard and blank the page
    // for every logged-out visitor — and a full-page app is the surface anon
    // traffic actually lands on.
    const { posts, init } = await mountAndCaptureInit({ viewer: null });
    expect(init.viewer).toBeNull();
    posts.stop();
  });

  test('a viewer with a null username keeps signedIn: true', async () => {
    const { posts, init } = await mountAndCaptureInit({
      viewer: { id: 6613, username: null },
    });
    expect(init.viewer).toEqual({ id: 6613, username: null, signedIn: true });
    posts.stop();
  });
});

describe('PageBlockHost BLOCK_INIT — the UNPROJECTED context is a second identity channel', () => {
  /**
   * 🔴 CHARACTERISATION, NOT AN ENDORSEMENT. This pins what the page surface
   * ACTUALLY discloses today, so the `@deprecated` prose on
   * `BlockInitPayload.viewer.id` cannot be read as a privacy guarantee it does
   * not deliver.
   *
   * `IframeHost` projects its slot context through `projectBlockInitContext`,
   * whose allowlist drops `viewerUserId` / `viewerUsername`. This host does not
   * project at all — `buildContext()` emits both verbatim. So deprecating
   * `viewer.id` / `viewer.username` ends unconditional identity disclosure on the
   * model slot and buys ZERO here.
   *
   * They were NOT removed: they are published SDK contract fields on
   * `PageContext`, and the deployed-population enumeration behind this file's
   * other keep/drop claims covered the `viewer` OBJECT, not `context.viewerUserId`
   * — removing them on that evidence would be generalising a measurement onto a
   * different field.
   *
   * If this test is in your way, you are doing the removal. Good — but do it with
   * the enumeration in hand and a PAGE-shaped allowlist (the model allowlist would
   * strip `slug` / `subPath` / `entityType` and break deep-linking), then update
   * the `PageContext` and `BlockInitPayload.viewer` notes in the same change.
   */
  test('🔴 context still carries viewerUserId/viewerUsername — the viewer.id deprecation buys ZERO here', async () => {
    const { posts, init } = await mountAndCaptureInit();
    const ctx = init.context as Record<string, unknown>;

    // Positive control on the read itself: a page context that had lost its own
    // routing fields would make the identity assertions below meaningless.
    expect(ctx.slotId).toBe('app.page');
    expect(ctx.slug).toBe('lanternfish-studio');

    expect(ctx.viewerUserId).toBe(8472);
    expect(ctx.viewerUsername).toBe('nimbus-drake');
    // …and it is the SAME identity the deprecated `viewer` object carries — two
    // channels, one of them undeprecated.
    expect(ctx.viewerUserId).toBe(init.viewer?.id);
    expect(ctx.viewerUsername).toBe(init.viewer?.username);
    posts.stop();
  });

  test('an anonymous page viewer discloses no identity on EITHER channel', async () => {
    const { posts, init } = await mountAndCaptureInit({ viewer: null });
    const ctx = init.context as Record<string, unknown>;

    expect(init.viewer).toBeNull();
    expect(ctx.viewerUserId).toBeNull();
    expect(ctx.viewerUsername).toBeNull();
    posts.stop();
  });
});

describe('PageBlockHost BLOCK_INIT — blockId / appId are DEPRECATED but MANDATORY', () => {
  /**
   * 🔴 REGRESSION GUARD AGAINST A FUTURE "CLEANUP" DELETING THESE FIELDS.
   *
   * `blockId` and `appId` are build-time identity a block already knows, and the
   * runtime-reader survey over the 9 CURRENTLY-APPROVED bundles found ZERO
   * readers. That combination reads as dead weight — which is exactly the trap.
   *
   * Every already-deployed bundle carries a compiled-in
   * `isValidBlockInitPayload` guard that REJECTS THE WHOLE BLOCK_INIT PAYLOAD
   * when either field is missing. That guard was fetched from each of those 9
   * and EXECUTED against a payload without them: it fails on every one, the
   * block never initialises, and the viewer sees a blank block. Dropping these
   * from the wire is therefore a fleet-wide outage, not a tidy-up.
   *
   * 🔴 WHICH NUMBER MEANS WHAT. 9 = approved, i.e. what is SERVED today (both
   * surfaces gate on `status: 'approved'`) and what was actually EXECUTED. The
   * population a COMPATIBILITY claim has to cover is the full deployed set —
   * 21 rows / 20 deployments in `app_blocks` — because a suspension is
   * reversible (`relistListing` flips suspended → approved and the untouched
   * bundle serves again). The other 11 deployments were not guard-executed; that
   * they behave the same is an inference from their shipping the same SDK guard.
   * Full note above `BlockInitPayload` in types.ts.
   *
   * If this test is in your way: the answer is NOT to delete it.
   */
  test('🔴 BLOCK_INIT still carries a non-empty blockId and appId — removing them blanks every deployed block', async () => {
    const { posts, init } = await mountAndCaptureInit();

    expect(init).toHaveProperty('blockId');
    expect(init).toHaveProperty('appId');
    expect(typeof init.blockId).toBe('string');
    expect(typeof init.appId).toBe('string');
    // Non-empty, and carrying the route's REAL values — an empty string survives
    // the `toHaveProperty` check but fails the deployed guard's truthiness test
    // just as a missing key does.
    expect(init.blockId).toBe('lanternfish-studio');
    expect(init.appId).toBe('app_peridot_7064');
    // …and not transposed with each other or with the instance id, which the
    // pairwise-distinct fixture makes observable.
    expect(init.blockInstanceId).toBe('page_apb_sandpiper_5527');
    posts.stop();
  });
});

describe('PageBlockHost REQUEST_TOKEN → TOKEN_REFRESH_RESPONSE.requestId', () => {
  /**
   * The block side's `refresh()` awaits a reply correlated STRICTLY by
   * `requestId`. An uncorrelated `TOKEN_REFRESH_RESPONSE` has never resolved it —
   * it only ever "worked" through the SDK's incidental token-snapshot side
   * effect while the caller's promise sat there until its own timeout.
   *
   * The old spread was `...(requestId ? { requestId } : {})` — a TRUTHINESS test,
   * so an empty-string id (which a block can legitimately mint and be waiting
   * on) was dropped too.
   */
  test('echoes a normal requestId back verbatim', async () => {
    const { posts } = await mountAndCaptureInit();

    postFromBlock('REQUEST_TOKEN', { requestId: 'req-marlin-4419' });

    await vi.waitFor(() => {
      const reply = posts.last('TOKEN_REFRESH_RESPONSE');
      if (!reply) throw new Error('no TOKEN_REFRESH_RESPONSE yet');
      expect((reply.payload as { requestId?: string }).requestId).toBe('req-marlin-4419');
    });
    const reply = posts.last('TOKEN_REFRESH_RESPONSE')!.payload as { token?: { raw?: string } };
    expect(reply.token?.raw).toBe('tok_saffron_1938');
    posts.stop();
  });

  test('🔴 echoes an EMPTY-STRING requestId — the truthiness spread used to drop it', async () => {
    const { posts } = await mountAndCaptureInit();

    postFromBlock('REQUEST_TOKEN', { requestId: '' });

    await vi.waitFor(() => {
      const reply = posts.last('TOKEN_REFRESH_RESPONSE');
      if (!reply) throw new Error('no TOKEN_REFRESH_RESPONSE yet');
      expect(Object.keys(reply.payload as object)).toContain('requestId');
      expect((reply.payload as { requestId?: string }).requestId).toBe('');
    });
    posts.stop();
  });

  test('🔴 a REQUEST_TOKEN with NO requestId gets a TOKEN_REFRESH push, never an uncorrelated response', async () => {
    const { posts } = await mountAndCaptureInit();

    // Count BEFORE: the rotation effect can legitimately push its own
    // TOKEN_REFRESH on a token/scope change, so the assertion is on the DELTA
    // this REQUEST_TOKEN causes, not on an absolute total.
    const pushesBefore = posts.of('TOKEN_REFRESH').length;
    postFromBlock('REQUEST_TOKEN', {});

    await vi.waitFor(() => {
      expect(posts.of('TOKEN_REFRESH').length).toBe(pushesBefore + 1);
    });
    expect(posts.of('TOKEN_REFRESH_RESPONSE')).toHaveLength(0);
    const push = posts.last('TOKEN_REFRESH')!.payload as { token?: { raw?: string } };
    expect(push.token?.raw).toBe('tok_saffron_1938');
    posts.stop();
  });

  test('a bare REQUEST_TOKEN (undefined payload) behaves the same way', async () => {
    const { posts } = await mountAndCaptureInit();

    const pushesBefore = posts.of('TOKEN_REFRESH').length;
    postFromBlock('REQUEST_TOKEN');

    await vi.waitFor(() => {
      expect(posts.of('TOKEN_REFRESH').length).toBe(pushesBefore + 1);
    });
    expect(posts.of('TOKEN_REFRESH_RESPONSE')).toHaveLength(0);
    posts.stop();
  });

  test('🔴 concurrent requests are each answered on their OWN id — no stale re-bind', async () => {
    // A host that replied with the id of a DIFFERENT (e.g. the most recent, or
    // the first-seen) request would resolve the wrong caller's promise and hang
    // the other. Two distinct ids, both of which must come back.
    const { posts } = await mountAndCaptureInit();

    postFromBlock('REQUEST_TOKEN', { requestId: 'req-thistle-8806' });
    postFromBlock('REQUEST_TOKEN', { requestId: 'req-cobweb-2371' });

    await vi.waitFor(() => {
      expect(posts.of('TOKEN_REFRESH_RESPONSE')).toHaveLength(2);
    });
    expect(
      posts.of('TOKEN_REFRESH_RESPONSE').map((m) => (m.payload as { requestId?: string }).requestId)
    ).toEqual(['req-thistle-8806', 'req-cobweb-2371']);
    posts.stop();
  });
});
