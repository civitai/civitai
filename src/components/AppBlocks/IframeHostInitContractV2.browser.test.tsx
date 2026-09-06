import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';

/**
 * BLOCK_INIT v2 contract — the MODEL-SLOT host (`model.sidebar_top`).
 *
 * Two things are pinned here, both of which a single-surface suite would miss:
 *
 *  1. `viewer.signedIn === true` reaches the wire. On THIS host the viewer is
 *     DERIVED from the slot context via `projectBlockInitViewer`; on
 *     `PageBlockHost` it arrives as an already-resolved PROP and never touches
 *     that projection. The two hosts share no bridge, so
 *     `PageBlockHostInitContractV2.browser.test.tsx` is the other half of this
 *     coverage and neither file can stand in for the other. The unit tests on
 *     `withSignedInFlag` pin the shape; only these pin that a host uses it.
 *
 *  2. `blockId` / `appId` are STILL SENT and non-empty. They are `@deprecated`
 *     with ZERO deployed readers, which makes them look exactly like dead weight
 *     a future cleanup would delete — see the regression guard below for why
 *     that would be a fleet-wide outage.
 *
 * Plus the `TOKEN_REFRESH_RESPONSE.requestId` correlation contract, which is
 * likewise duplicated per host.
 *
 * Mocks mirror `IframeHostThemeChange.browser.test.tsx` (the model-slot
 * scaffold): the two tRPC queries IframeHost drives at render must report
 * `isLoading: false` so the init handshake is allowed to start.
 */
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// 🔴 `useOptionalFeatureFlags` IS LISTED TOO, AND OMITTING IT BREAKS THE WHOLE FILE.
// This factory REPLACES the module (deliberately — see the note above), so it must
// name every export anything in this file's module graph imports. The app-block
// chrome's breadcrumb crumb reads `useOptionalFeatureFlags` for its store gate (the
// non-throwing variant, because the chrome renders outside a provider), and the day
// it started doing so this factory stopped satisfying the link:
//   SyntaxError: The requested module '/src/providers/FeatureFlagsProvider.tsx'
//   does not provide an export named 'useOptionalFeatureFlags'
//
// 🔴 THE FILE THEN FAILS TO IMPORT, WHICH IS NOT THE SAME AS FAILING. Nothing is
// collected, so the run reported `Test Files 6 failed` alongside `Tests 374 passed`
// — zero failing ASSERTIONS. Anything reading a failure count, or a per-test
// summary, sees success. Read the FILE count, not the test count.
//
// Both hooks return the SAME flags: the gate must be decided by this fixture, not
// by which of the two a component happens to call.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    blocks: {
      getEffectiveCheckpoint: {
        useQuery: () => ({ data: { checkpoint: null }, isLoading: false }),
      },
      getShowcaseImages: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      updateUserSettings: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type {
  BlockInitPayload,
  BlockInstall,
  ModelSlotContext,
} from '~/components/AppBlocks/types';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

function iframeEl() {
  return page.getByTestId('block-iframe').element() as HTMLIFrameElement;
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
 * Fixture values are NON-DEFAULT and PAIRWISE DISTINCT on purpose.
 *
 * Every id here is a different number and every name a different string, so no
 * assertion below can pass by two fields collapsing onto the same value — a
 * transposition mutant (`id`↔`username`, `blockId`↔`appId`) has to change what
 * lands on the wire, and a zeroed/emptied payload cannot masquerade as a
 * populated one.
 */
const install: BlockInstall = {
  blockInstanceId: 'inst_kestrel_9471',
  blockId: 'tidewater-remix',
  appId: 'app_obsidian_3308',
  appBlockId: 'apb_juniper_6215',
  manifest: {
    name: 'Tidewater Remix',
    scopes: ['ai:write:budgeted'],
    iframe: {
      src: SAME_ORIGIN_SRC,
      minHeight: 240,
      maxHeight: 900,
      resizable: true,
      sandbox: 'allow-scripts',
    },
  },
  publisherSettings: {},
  enabled: true,
  renderMode: 'iframe',
  trustTier: 'internal',
};

function signedInContext(): ModelSlotContext {
  return {
    slotId: 'model.sidebar_top',
    entityType: 'model',
    modelId: 7742,
    modelVersionId: 8891,
    modelName: 'Cobalt Meridian',
    modelType: 'Checkpoint',
    modelNsfwLevel: 1,
    creatorUserId: 3157,
    viewerUserId: 5150,
    viewerNsfwEnabled: false,
    viewerUsername: 'zephyr-quill',
    theme: 'light',
  };
}

function anonymousContext(): ModelSlotContext {
  return { ...signedInContext(), viewerUserId: null, viewerUsername: null };
}

const baseProps = {
  install,
  token: 'tok_verdigris_4482',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
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
async function mountAndCaptureInit(context: ModelSlotContext) {
  await renderWithProviders(<IframeHost {...baseProps} context={context} />);
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

describe('IframeHost BLOCK_INIT — viewer.signedIn (v2)', () => {
  test('a signed-in viewer reaches the block with signedIn: true', async () => {
    const { posts, init } = await mountAndCaptureInit(signedInContext());
    // The literal `true`, not merely truthy: `signedIn: false` / `1` / `'yes'`
    // must all fail here.
    expect(init.viewer?.signedIn).toBe(true);
    posts.stop();
  });

  test('the deprecated id/username still ride along, correct and un-swapped', async () => {
    const { posts, init } = await mountAndCaptureInit(signedInContext());
    // Deprecated (unconditional identity disclosure; `GET_VIEWER` is the
    // replacement) but NOT removable: the `isValidBlockInitPayload` guard
    // compiled into every deployed bundle rejects a viewer without a numeric
    // `id`, and 5 of the 9 currently-approved apps read it for
    // ownership/authorship logic.
    expect(init.viewer?.id).toBe(5150);
    expect(init.viewer?.username).toBe('zephyr-quill');
    posts.stop();
  });

  test('the viewer object carries EXACTLY id + username + signedIn', async () => {
    const { posts, init } = await mountAndCaptureInit(signedInContext());
    expect(Object.keys(init.viewer ?? {}).sort()).toEqual(['id', 'signedIn', 'username']);
    // The privacy fields the projection drops must not reappear via the host.
    expect(init.viewer).not.toHaveProperty('status');
    expect(init.viewer).not.toHaveProperty('viewerNsfwEnabled');
    posts.stop();
  });

  test('🔴 an anonymous viewer is NULL — never an object with signedIn: false', async () => {
    // The wire shape is frozen at `object-or-null` by the deployed guard, which
    // accepts only `null` or an object with a NUMERIC `id`. An anonymous viewer
    // rendered as `{ signedIn: false }` would fail that guard and blank the
    // block for every logged-out visitor.
    const { posts, init } = await mountAndCaptureInit(anonymousContext());
    expect(init.viewer).toBeNull();
    posts.stop();
  });
});

describe('IframeHost BLOCK_INIT — blockId / appId are DEPRECATED but MANDATORY', () => {
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
   * from the wire is therefore a fleet-wide outage, not a tidy-up — and no
   * publisher can be forced to rebuild against a v2 guard on our schedule.
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
    const { posts, init } = await mountAndCaptureInit(signedInContext());

    expect(init).toHaveProperty('blockId');
    expect(init).toHaveProperty('appId');
    expect(typeof init.blockId).toBe('string');
    expect(typeof init.appId).toBe('string');
    // Non-empty, and carrying the install's REAL values — an empty string
    // survives the `toHaveProperty` check but fails the deployed guard's
    // truthiness test just as a missing key does.
    expect(init.blockId).toBe('tidewater-remix');
    expect(init.appId).toBe('app_obsidian_3308');
    // …and not transposed with each other or with the instance id, which the
    // pairwise-distinct fixture makes observable.
    expect(init.blockInstanceId).toBe('inst_kestrel_9471');
    posts.stop();
  });
});

describe('IframeHost REQUEST_TOKEN → TOKEN_REFRESH_RESPONSE.requestId', () => {
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
    const { posts } = await mountAndCaptureInit(signedInContext());

    postFromBlock('REQUEST_TOKEN', { requestId: 'req-cinnabar-7789' });

    await vi.waitFor(() => {
      const reply = posts.last('TOKEN_REFRESH_RESPONSE');
      if (!reply) throw new Error('no TOKEN_REFRESH_RESPONSE yet');
      expect((reply.payload as { requestId?: string }).requestId).toBe('req-cinnabar-7789');
    });
    // The reply still carries the wrapped token — correlation was added, not
    // traded for the payload.
    const reply = posts.last('TOKEN_REFRESH_RESPONSE')!.payload as {
      token?: { raw?: string };
    };
    expect(reply.token?.raw).toBe('tok_verdigris_4482');
    posts.stop();
  });

  test('🔴 echoes an EMPTY-STRING requestId — the truthiness spread used to drop it', async () => {
    const { posts } = await mountAndCaptureInit(signedInContext());

    postFromBlock('REQUEST_TOKEN', { requestId: '' });

    await vi.waitFor(() => {
      const reply = posts.last('TOKEN_REFRESH_RESPONSE');
      if (!reply) throw new Error('no TOKEN_REFRESH_RESPONSE yet');
      // Present as an own property AND equal to '' — `toBe('')` alone would also
      // pass on `undefined`-vs-missing confusion in a weaker matcher chain.
      expect(Object.keys(reply.payload as object)).toContain('requestId');
      expect((reply.payload as { requestId?: string }).requestId).toBe('');
    });
    posts.stop();
  });

  test('🔴 a REQUEST_TOKEN with NO requestId gets a TOKEN_REFRESH push, never an uncorrelated response', async () => {
    const { posts } = await mountAndCaptureInit(signedInContext());

    // Count BEFORE: the H-3 rotation effect can legitimately push its own
    // TOKEN_REFRESH on a token/scope change, so the assertion is on the DELTA
    // this REQUEST_TOKEN causes, not on an absolute total.
    const pushesBefore = posts.of('TOKEN_REFRESH').length;
    postFromBlock('REQUEST_TOKEN', {});

    await vi.waitFor(() => {
      expect(posts.of('TOKEN_REFRESH').length).toBe(pushesBefore + 1);
    });
    // A host-initiated rotation with nothing to correlate to IS a TOKEN_REFRESH.
    // What must never happen is a TOKEN_REFRESH_RESPONSE the block cannot match
    // to any pending request.
    expect(posts.of('TOKEN_REFRESH_RESPONSE')).toHaveLength(0);
    const push = posts.last('TOKEN_REFRESH')!.payload as { token?: { raw?: string } };
    expect(push.token?.raw).toBe('tok_verdigris_4482');
    posts.stop();
  });

  test('a bare REQUEST_TOKEN (undefined payload) behaves the same way', async () => {
    const { posts } = await mountAndCaptureInit(signedInContext());

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
    const { posts } = await mountAndCaptureInit(signedInContext());

    postFromBlock('REQUEST_TOKEN', { requestId: 'req-alabaster-2264' });
    postFromBlock('REQUEST_TOKEN', { requestId: 'req-fennel-9053' });

    await vi.waitFor(() => {
      expect(posts.of('TOKEN_REFRESH_RESPONSE')).toHaveLength(2);
    });
    expect(
      posts.of('TOKEN_REFRESH_RESPONSE').map((m) => (m.payload as { requestId?: string }).requestId)
    ).toEqual(['req-alabaster-2264', 'req-fennel-9053']);
    posts.stop();
  });
});
