import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `blocks.previewPostFromApp` / `blocks.createPostFromApp` — the ROUTER-level
 * guard matrix.
 *
 * The per-guard SERVICE logic (tag policy, self-dealing, provenance, atomicity)
 * is covered in `block-post.service.test.ts`. What can only be seen HERE is the
 * PREAMBLE and its ORDER: scope → subject → runtime flag → the dedicated post
 * flag → write trust → rate buckets, and the audit row that must be written
 * whether the post succeeds or fails.
 *
 * 🔴 EVERY NEGATIVE CASE ALSO ASSERTS THAT THE NEXT STAGE WAS NOT REACHED. A
 * refusal test that only checks the thrown code passes when an unrelated later
 * gate throws the same code — and several of these do throw FORBIDDEN. Pairing
 * each refusal with "…and the write service was never called" is what makes the
 * case a claim about the guard in its title.
 */

const {
  mockAuthorizeBlockBridgeToken,
  mockParseSubjectUserId,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksAuthorEnabled,
  mockIsAppBlocksPostCreationEnabled,
  mockGetSessionUser,
  mockGetOrchestratorToken,
  mockGetWorkflow,
  mockCheckCatalogRate,
  mockCheckPostRate,
  mockCheckPostAppRate,
  mockCheckPublishRate,
  mockPreviewBlockPost,
  mockResolveBlockPostSources,
  mockResolveExistingPostTags,
  mockResolveGalleryTarget,
  mockWriteBlockPost,
  mockApplyEffects,
  mockPersistImage,
  mockRecordScopeInvocation,
  mockThrowOnBlockedUserContent,
} = vi.hoisted(() => ({
  mockAuthorizeBlockBridgeToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsAppBlocksAuthorEnabled: vi.fn(),
  mockIsAppBlocksPostCreationEnabled: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
  mockCheckCatalogRate: vi.fn(),
  mockCheckPostRate: vi.fn(),
  mockCheckPostAppRate: vi.fn(),
  mockCheckPublishRate: vi.fn(),
  mockPreviewBlockPost: vi.fn(),
  mockResolveBlockPostSources: vi.fn(),
  mockResolveExistingPostTags: vi.fn(),
  mockResolveGalleryTarget: vi.fn(),
  mockWriteBlockPost: vi.fn(),
  mockApplyEffects: vi.fn(),
  mockPersistImage: vi.fn(),
  mockRecordScopeInvocation: vi.fn(),
  mockThrowOnBlockedUserContent: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: (...a: unknown[]) => mockAuthorizeBlockBridgeToken(...a),
}));
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a) };
});
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: (...a: unknown[]) => mockIsAppBlocksEnabled(...a),
  isAppBlocksAuthorEnabled: (...a: unknown[]) => mockIsAppBlocksAuthorEnabled(...a),
  isAppBlocksPostCreationEnabled: (...a: unknown[]) => mockIsAppBlocksPostCreationEnabled(...a),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: (...a: unknown[]) => mockGetOrchestratorToken(...a),
}));
vi.mock('~/server/services/blocks/workflow.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getWorkflow: (...a: unknown[]) => mockGetWorkflow(...a) };
});
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...a: unknown[]) => mockCheckCatalogRate(...a),
  checkBlockPostRateLimit: (...a: unknown[]) => mockCheckPostRate(...a),
  checkBlockPostAppRateLimit: (...a: unknown[]) => mockCheckPostAppRate(...a),
  checkBlockPublishRateLimit: (...a: unknown[]) => mockCheckPublishRate(...a),
}));
vi.mock('~/server/services/blocks/block-post.service', () => ({
  previewBlockPost: (...a: unknown[]) => mockPreviewBlockPost(...a),
  resolveBlockPostSources: (...a: unknown[]) => mockResolveBlockPostSources(...a),
  resolveExistingPostTags: (...a: unknown[]) => mockResolveExistingPostTags(...a),
  resolveGalleryTarget: (...a: unknown[]) => mockResolveGalleryTarget(...a),
  writeBlockPost: (...a: unknown[]) => mockWriteBlockPost(...a),
  applyBlockPostPublishEffects: (...a: unknown[]) => mockApplyEffects(...a),
}));
vi.mock('~/server/services/blocks/block-image-upload.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    persistBlockWorkflowOutputImage: (...a: unknown[]) => mockPersistImage(...a),
  };
});
vi.mock('~/server/services/blocks/user-app-surface.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, recordScopeInvocation: (...a: unknown[]) => mockRecordScopeInvocation(...a) };
});
vi.mock('~/server/services/blocklist.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    throwOnBlockedUserContent: (...a: unknown[]) => mockThrowOnBlockedUserContent(...a),
  };
});
// Same import-chain shim the sibling blocks.router suites use: `rateLimit`
// transitively evaluates a top-level `Prisma.validator(...)`, which cannot run here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const VIEWER_ID = 42;

function claims(over: Record<string, unknown> = {}) {
  return {
    sub: `user:${VIEWER_ID}`,
    scopes: ['posts:write:self'],
    appId: 'appblk-alpha',
    appBlockId: 'apb_alpha',
    blockInstanceId: 'bki_alpha',
    blockId: 'my-app',
    maxBrowsingLevel: 1,
    ...over,
  };
}

/** A viewer who passes `assertSharedWriteTrust`: old enough, verified, onboarded. */
function trustedUser(over: Record<string, unknown> = {}) {
  return {
    id: VIEWER_ID,
    emailVerified: new Date('2020-01-01'),
    // OnboardingSteps.Buzz — set every bit so the flag check passes regardless of
    // which bit it is; the muted/banned/age cases below are what this suite pins.
    onboarding: 0xffff,
    createdAt: new Date('2020-01-01'),
    bannedAt: null,
    muted: false,
    tier: 'free',
    ...over,
  };
}

function ctx() {
  return {
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    ip: '203.0.113.9',
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: { post: vi.fn(async () => undefined) },
  };
}

// `confirmedImageCount` is REQUIRED on the write arm and must match the default
// one-image resolution below; cases that resolve a different number override it.
const INPUT = {
  blockToken: 'tok',
  sources: [{ kind: 'workflow' as const, workflowId: 'wf_1' }],
  confirmedImageCount: 1,
};

function caller(c = ctx()) {
  return blocksRouter.createCaller(c as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorizeBlockBridgeToken.mockResolvedValue(claims());
  mockParseSubjectUserId.mockImplementation((sub: string) =>
    sub === 'anon' ? null : Number(sub.slice('user:'.length))
  );
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockIsAppBlocksPostCreationEnabled.mockResolvedValue(true);
  mockGetSessionUser.mockResolvedValue(trustedUser());
  mockGetOrchestratorToken.mockResolvedValue('orch-token');
  mockCheckCatalogRate.mockResolvedValue({ allowed: true });
  mockCheckPostRate.mockResolvedValue({ allowed: true });
  mockCheckPostAppRate.mockResolvedValue({ allowed: true });
  mockCheckPublishRate.mockResolvedValue({ allowed: true });
  mockPreviewBlockPost.mockResolvedValue({
    title: null,
    detail: null,
    tags: [],
    droppedTags: [],
    images: [{ url: 'https://edge/a', width: 1, height: 1 }],
    gallery: null,
  });
  mockResolveExistingPostTags.mockResolvedValue({ tagIds: [], names: [], dropped: [] });
  mockResolveBlockPostSources.mockResolvedValue([
    // `nsfwLevel` is NsfwLevel.PG (1). A `published` source carries the image's
    // already-computed level; it is what the ClickHouse `nsfw` flag is derived
    // from, since `Post.nsfwLevel` does not exist yet on this path.
    { kind: 'published', imageId: 501, url: 'u', width: 1, height: 1, nsfwLevel: 1 },
  ]);
  mockWriteBlockPost.mockResolvedValue({
    postId: 5150,
    url: '/posts/5150',
    imageIds: [501],
    modelVersionId: null,
    tagNames: [],
  });
  mockApplyEffects.mockResolvedValue(undefined);
  dbMock.dbRead.account.count.mockResolvedValue(1);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the shared preamble — createPostFromApp', () => {
  it('REFUSES a token without posts:write:self, and never charges a rate bucket', async () => {
    // Note the fixture: the token HAS `ai:write:budgeted`. That is the scope the
    // publish bridge accepts, so this case also pins that the two are NOT
    // interchangeable — an app allowed to spend the viewer's Buzz on a generation
    // is not thereby allowed to publish under their name.
    mockAuthorizeBlockBridgeToken.mockResolvedValue(claims({ scopes: ['ai:write:budgeted'] }));

    await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block lacks posts:write:self scope',
    });
    expect(mockCheckPostRate).not.toHaveBeenCalled();
    expect(mockWriteBlockPost).not.toHaveBeenCalled();
  });

  it('REFUSES an anonymous subject', async () => {
    mockAuthorizeBlockBridgeToken.mockResolvedValue(claims({ sub: 'anon' }));

    await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'posting requires an authenticated viewer',
    });
    expect(mockWriteBlockPost).not.toHaveBeenCalled();
  });

  it('REFUSES when the App-Blocks runtime flag is off for the SUBJECT', async () => {
    mockIsAppBlocksEnabled.mockResolvedValue(false);

    await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Apps are not enabled',
    });
    expect(mockWriteBlockPost).not.toHaveBeenCalled();
  });

  describe('🔴 the DEDICATED post-creation flag', () => {
    it('REFUSES when it is off, even with the runtime flag fully ON', async () => {
      // The whole reason the second flag exists: a GA widening of
      // `app-blocks-enabled` must not arm public post creation on the same day.
      // The fixture proves independence by leaving the runtime flag true.
      mockIsAppBlocksEnabled.mockResolvedValue(true);
      mockIsAppBlocksPostCreationEnabled.mockResolvedValue(false);

      await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'posting from apps is not enabled',
      });
      expect(mockWriteBlockPost).not.toHaveBeenCalled();
    });

    it('is evaluated with the TOKEN SUBJECT, never a session user', async () => {
      await caller().createPostFromApp(INPUT);
      expect(mockGetSessionUser).toHaveBeenCalledWith(VIEWER_ID);
      expect(mockIsAppBlocksPostCreationEnabled).toHaveBeenCalledWith({
        user: expect.objectContaining({ id: VIEWER_ID }),
      });
    });

    it('gates the read-only PREVIEW too — a dark capability must not leak a resolver', async () => {
      mockIsAppBlocksPostCreationEnabled.mockResolvedValue(false);
      await expect(caller().previewPostFromApp(INPUT)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'posting from apps is not enabled',
      });
      expect(mockPreviewBlockPost).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('write trust', () => {
  it.each([
    ['a muted account', { muted: true }, 'Your account has been restricted'],
    ['a banned account', { bannedAt: new Date() }, 'Your account is not eligible for this action'],
    [
      'an account younger than 7 days',
      { createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) },
      'Your account is too new to contribute',
    ],
    ['an un-onboarded account', { onboarding: 0 }, 'Complete onboarding before contributing'],
  ])('REFUSES %s', async (_label, over, message) => {
    mockGetSessionUser.mockResolvedValue(trustedUser(over));

    await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message,
    });
    expect(mockWriteBlockPost).not.toHaveBeenCalled();
  });

  it('REFUSES an unverified account with NO linked OAuth, and ACCEPTS one with a link', async () => {
    mockGetSessionUser.mockResolvedValue(trustedUser({ emailVerified: null }));
    dbMock.dbRead.account.count.mockResolvedValue(0);
    await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
      message: 'Verify your email before contributing',
    });

    // The positive control: same unverified user, one linked provider account.
    // Without it, a mutant that refused every unverified user would pass above.
    dbMock.dbRead.account.count.mockResolvedValue(1);
    await expect(caller().createPostFromApp(INPUT)).resolves.toMatchObject({ postId: 5150 });
  });

  it('does NOT gate the read-only PREVIEW on write trust', async () => {
    // Deliberate: the preview writes nothing, and refusing it would tell a
    // too-new account nothing useful while costing an extra failure mode. The
    // WRITE is where trust binds.
    mockGetSessionUser.mockResolvedValue(trustedUser({ muted: true }));
    await expect(caller().previewPostFromApp(INPUT)).resolves.toMatchObject({
      images: [{ url: 'https://edge/a', width: 1, height: 1 }],
    });
    expect(mockPreviewBlockPost).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('rate buckets', () => {
  it('charges the POST bucket once per call, and the PUBLISH bucket by image count', async () => {
    mockResolveBlockPostSources.mockResolvedValue([
      { kind: 'published', imageId: 1, url: 'u', width: 1, height: 1 },
      { kind: 'published', imageId: 2, url: 'u', width: 1, height: 1 },
      { kind: 'published', imageId: 3, url: 'u', width: 1, height: 1 },
    ]);

    await caller().createPostFromApp({ ...INPUT, confirmedImageCount: 3 });

    expect(mockCheckPostRate).toHaveBeenCalledTimes(1);
    expect(mockCheckPostRate).toHaveBeenCalledWith('bki_alpha');
    // The per-image origin cost still lands on the publish bucket, so the post
    // path cannot be used to route around the per-image ceiling.
    expect(mockCheckPublishRate).toHaveBeenCalledWith('bki_alpha', 3);
  });

  it('REFUSES over the post ceiling before resolving any source', async () => {
    mockCheckPostRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });

    await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockResolveBlockPostSources).not.toHaveBeenCalled();
    expect(mockWriteBlockPost).not.toHaveBeenCalled();
  });

  it('charges the APP bucket too, keyed on appId — the aggregate the instance bucket cannot see', async () => {
    await caller().createPostFromApp(INPUT);

    expect(mockCheckPostAppRate).toHaveBeenCalledTimes(1);
    expect(mockCheckPostAppRate).toHaveBeenCalledWith('appblk-alpha');
    // 🔴 THE KEY IS THE CLAIM. Handing it the INSTANCE id would compile, pass
    // every other assertion in this file, and silently make the app ceiling a
    // second copy of the per-instance one.
    expect(mockCheckPostAppRate).not.toHaveBeenCalledWith('bki_alpha');
  });

  it('🔴 REFUSES over the APP ceiling even when the instance bucket still allows', async () => {
    // THE AGGREGATION GAP, directly. The per-instance bucket is keyed on the
    // install, so an app with N installs gets N × its ceiling and nothing sees
    // the total. Here the instance bucket says yes and the post is still refused.
    mockCheckPostRate.mockResolvedValue({ allowed: true });
    mockCheckPostAppRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 900 });

    await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockResolveBlockPostSources).not.toHaveBeenCalled();
    expect(mockWriteBlockPost).not.toHaveBeenCalled();
  });

  it('a DIFFERENT app is unaffected by the first app’s exhausted ceiling', async () => {
    // The half that proves the bucket is APP-scoped and not accidentally global.
    // Without it, a limiter keyed on a constant would pass the refusal case above
    // and every other assertion here.
    const exhausted = new Set(['appblk-alpha']);
    mockCheckPostAppRate.mockImplementation(async (appId: string) =>
      exhausted.has(appId) ? { allowed: false, retryAfterSeconds: 900 } : { allowed: true }
    );

    await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });

    mockAuthorizeBlockBridgeToken.mockResolvedValue(
      claims({ appId: 'appblk-beta', blockInstanceId: 'bki_beta' })
    );
    await expect(caller().createPostFromApp(INPUT)).resolves.toMatchObject({ postId: 5150 });
    expect(mockCheckPostAppRate).toHaveBeenLastCalledWith('appblk-beta');
  });

  it('the PREVIEW charges neither post bucket', async () => {
    await caller().previewPostFromApp(INPUT);
    expect(mockCheckPostAppRate).not.toHaveBeenCalled();
  });

  it('REFUSES over the image ceiling before materialising anything', async () => {
    mockCheckPublishRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });

    await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockPersistImage).not.toHaveBeenCalled();
    expect(mockWriteBlockPost).not.toHaveBeenCalled();
  });

  it('the PREVIEW charges the CATALOG bucket, never the post bucket', async () => {
    // Charging a read against the 3-posts/hour budget would let a block exhaust
    // its own posting allowance by rendering dialogs, and the viewer would see a
    // rate-limit error for an action they never took.
    await caller().previewPostFromApp(INPUT);
    expect(mockCheckCatalogRate).toHaveBeenCalledWith('bki_alpha');
    expect(mockCheckPostRate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('content + gallery re-derivation on the WRITE path', () => {
  it('re-validates text and re-resolves tags — it does NOT trust the preview', async () => {
    mockResolveExistingPostTags.mockResolvedValue({
      tagIds: [11],
      names: ['anime'],
      dropped: ['nope'],
    });

    await caller().createPostFromApp({ ...INPUT, title: '  Hi  ', tags: ['Anime', 'nope'] });

    // Tags resolved again on the write path…
    expect(mockResolveExistingPostTags).toHaveBeenCalledWith(['Anime', 'nope']);
    // …and only the RESOLVED names reach the row.
    expect(mockWriteBlockPost).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Hi', tagIds: [11], tagNames: ['anime'] })
    );
  });

  it('screens title, detail AND the resolved tag names — native screens only the first two', async () => {
    mockResolveExistingPostTags.mockResolvedValue({
      tagIds: [11],
      names: ['anime'],
      dropped: [],
    });

    await caller().createPostFromApp({ ...INPUT, title: 'T', detail: 'D', tags: ['anime'] });

    expect(mockThrowOnBlockedUserContent).toHaveBeenCalledWith(['T', 'D', 'anime'], {
      surface: 'post',
    });
  });

  it('screens the DROPPED tag names too — they are what the consent dialog renders', async () => {
    // 🔴 DISPLAY, NOT APPLICATION, IS WHAT PUTS THEM IN SCOPE. A name that
    // resolved to no `Tag` row is never written anywhere — but it IS returned as
    // `droppedTags` and rendered verbatim in the host confirm, so leaving it
    // unscreened would mean the one string on that surface the block fully
    // controls is also the one string the blocklist never sees.
    mockResolveExistingPostTags.mockResolvedValue({
      tagIds: [11],
      names: ['anime'],
      dropped: ['unresolved-name'],
    });

    await caller().createPostFromApp({ ...INPUT, title: 'T', detail: 'D', tags: ['anime', 'x'] });

    expect(mockThrowOnBlockedUserContent).toHaveBeenCalledWith(
      ['T', 'D', 'anime', 'unresolved-name'],
      { surface: 'post' }
    );
  });

  it('DERIVES the ClickHouse nsfw flag from the adopted images, not a hardcoded false', async () => {
    // 🔴 IT USED TO BE THE LITERAL `false`, so every app-created post landed in
    // ClickHouse as SFW regardless of content. It cannot be derived the native way
    // (`!getIsSafeBrowsingLevel(post.nsfwLevel)`) because at this instant
    // `Post.nsfwLevel` is still 0 — this path INSERTs `publishedAt` rather than
    // UPDATEing it, so the level is computed later by the job queue. So it is
    // derived from what the post is MADE of: the bit_or of the adopted images'
    // levels, which is exactly what `updatePostNsfwLevels` will compute.
    const c = ctx();

    // NsfwLevel.PG (1) | NsfwLevel.PG13 (2) === 3 — a value equal to neither
    // operand, and entirely inside the SFW flag.
    mockResolveBlockPostSources.mockResolvedValue([
      { kind: 'published', imageId: 501, url: 'u', width: 1, height: 1, nsfwLevel: 1 },
      { kind: 'published', imageId: 502, url: 'v', width: 1, height: 1, nsfwLevel: 2 },
    ]);
    await caller(c).createPostFromApp({ ...INPUT, confirmedImageCount: 2 });

    expect(c.track.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Create', nsfw: false })
    );
    expect(c.track.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Publish', nsfw: false })
    );
  });

  it('flags nsfw when ANY adopted image carries an nsfw bit', async () => {
    // The positive control for the case above: without it, a mutant hardcoding
    // `false` again would still pass it.
    const c = ctx();
    mockResolveBlockPostSources.mockResolvedValue([
      { kind: 'published', imageId: 501, url: 'u', width: 1, height: 1, nsfwLevel: 1 },
      // NsfwLevel.R (4) — in `nsfwBrowsingLevelsArray`.
      { kind: 'published', imageId: 502, url: 'v', width: 1, height: 1, nsfwLevel: 4 },
    ]);
    await caller(c).createPostFromApp({ ...INPUT, confirmedImageCount: 2 });

    expect(c.track.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Create', nsfw: true })
    );
    expect(c.track.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Publish', nsfw: true })
    );
  });

  it('flags a MIXED post nsfw — one unscanned output unrates the whole post', async () => {
    // 🔴 THE ARM THAT ERRED PERMISSIVE. The derivation used to be a plain reduce
    // over `published` members only, so this post — one PG image plus one fresh
    // output — reduced to the PG bit alone and was recorded `nsfw: false`
    // PERMANENTLY, even after the fresh output scans X and `Post.nsfwLevel`
    // becomes 9. Unlike `Post.nsfwLevel`, this row is written once and never
    // revisited, so nothing corrects it. A fresh member now forces the same
    // unrated verdict the all-fresh arm already produced, which is the
    // conservative direction and makes both arms agree.
    const c = ctx();
    mockResolveBlockPostSources.mockResolvedValue([
      // NsfwLevel.PG (1) — squarely inside the SFW flag on its own.
      { kind: 'published', imageId: 501, url: 'u', width: 1, height: 1, nsfwLevel: 1 },
      { kind: 'workflow', url: 'https://orchestration.civitai.com/a.jpg', width: 1, height: 1 },
    ]);
    mockPersistImage.mockResolvedValue({ imageId: 777 });
    await caller(c).createPostFromApp({ ...INPUT, confirmedImageCount: 2 });

    expect(c.track.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Create', nsfw: true })
    );
    expect(c.track.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Publish', nsfw: true })
    );
  });

  it('flags an ALL-FRESH post nsfw — an unscanned output has no level to derive from', async () => {
    // Not a gap being papered over: a `fresh` workflow output is unscanned by
    // construction, so no expression here could invent a level. The native
    // predicate reads 0 as nsfw (`getIsSafeBrowsingLevel(0)` is false — 0 means
    // UNRATED, not safe), i.e. it errs conservative, which is the right direction
    // for the value it replaces.
    const c = ctx();
    mockResolveBlockPostSources.mockResolvedValue([
      { kind: 'workflow', url: 'https://orchestration.civitai.com/a.jpg', width: 1, height: 1 },
    ]);
    mockPersistImage.mockResolvedValue({ imageId: 777 });
    await caller(c).createPostFromApp(INPUT);

    expect(c.track.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Create', nsfw: true })
    );
  });

  it('REFUSES over-long copy with the text guard’s own message, before any resolution', async () => {
    await expect(
      caller().createPostFromApp({ ...INPUT, detail: 'x'.repeat(2001) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockResolveBlockPostSources).not.toHaveBeenCalled();
  });

  it('re-runs the gallery gate on the write path when modelVersionId is present', async () => {
    mockResolveGalleryTarget.mockResolvedValue({
      modelVersionId: 3100,
      modelId: 800,
      modelName: 'M',
      versionName: 'v1',
    });
    await caller().createPostFromApp({ ...INPUT, modelVersionId: 3100 });
    expect(mockResolveGalleryTarget).toHaveBeenCalledWith({
      modelVersionId: 3100,
      posterUserId: VIEWER_ID,
      appId: 'appblk-alpha',
    });
  });

  it('does NOT call the gallery gate when no attach was requested', async () => {
    await caller().createPostFromApp(INPUT);
    expect(mockResolveGalleryTarget).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('materialisation + audit', () => {
  it('materialises only WORKFLOW sources; a published image is adopted by id', async () => {
    mockResolveBlockPostSources.mockResolvedValue([
      { kind: 'workflow', url: 'https://orch/a.jpg', width: 1, height: 1 },
      { kind: 'published', imageId: 777, url: 'u', width: 1, height: 1 },
    ]);
    mockPersistImage.mockResolvedValue({ imageId: 888 });

    await caller().createPostFromApp({ ...INPUT, confirmedImageCount: 2 });

    expect(mockPersistImage).toHaveBeenCalledTimes(1);
    // Order preserved: the workflow output first, then the adopted image.
    expect(mockWriteBlockPost).toHaveBeenCalledWith(
      expect.objectContaining({ materialisedImageIds: [888, 777] })
    );
  });

  it('writes an audit row on SUCCESS carrying the post id and image count', async () => {
    mockResolveBlockPostSources.mockResolvedValue([
      { kind: 'published', imageId: 1, url: 'u', width: 1, height: 1 },
      { kind: 'published', imageId: 2, url: 'u', width: 1, height: 1 },
    ]);

    await caller().createPostFromApp({ ...INPUT, confirmedImageCount: 2 });

    expect(mockRecordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: VIEWER_ID,
        appBlockId: 'apb_alpha',
        blockInstanceId: 'bki_alpha',
        scope: 'posts:write:self',
        // Templated, NOT `post:create:<id>` — `endpoint` is the topEndpoints
        // GROUP BY key and must stay bounded.
        endpoint: 'post:create',
        statusCode: 200,
        detail: expect.objectContaining({
          action: 'post.create',
          outcome: 'ok',
          imageCount: 2,
          entityType: 'Post',
          entityId: 5150,
        }),
      })
    );
  });

  it('🔴 writes an audit row on FAILURE too — a failed attempt is the interesting one', async () => {
    mockWriteBlockPost.mockRejectedValue(new Error('boom'));

    await expect(caller().createPostFromApp(INPUT)).rejects.toThrow('boom');

    expect(mockRecordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        detail: expect.objectContaining({ action: 'post.create', outcome: 'failed' }),
      })
    );
  });

  it('records the gallery target when one was attached, and omits it otherwise', async () => {
    mockResolveGalleryTarget.mockResolvedValue({
      modelVersionId: 3100,
      modelId: 800,
      modelName: 'M',
      versionName: 'v1',
    });
    mockWriteBlockPost.mockResolvedValue({
      postId: 5150,
      url: '/posts/5150',
      imageIds: [501],
      modelVersionId: 3100,
      tagNames: [],
    });
    await caller().createPostFromApp({ ...INPUT, modelVersionId: 3100 });
    expect(mockRecordScopeInvocation.mock.calls[0][0].detail.modelVersionId).toBe(3100);

    // The ABSENCE is the signal that no model owner was paid, so it must be a
    // real absence rather than a null.
    vi.clearAllMocks();
    mockAuthorizeBlockBridgeToken.mockResolvedValue(claims());
    mockParseSubjectUserId.mockReturnValue(VIEWER_ID);
    mockIsAppBlocksEnabled.mockResolvedValue(true);
    mockIsAppBlocksPostCreationEnabled.mockResolvedValue(true);
    mockGetSessionUser.mockResolvedValue(trustedUser());
    mockCheckPostRate.mockResolvedValue({ allowed: true });
    mockCheckPublishRate.mockResolvedValue({ allowed: true });
    mockResolveExistingPostTags.mockResolvedValue({ tagIds: [], names: [], dropped: [] });
    mockResolveBlockPostSources.mockResolvedValue([
      { kind: 'published', imageId: 1, url: 'u', width: 1, height: 1 },
    ]);
    mockWriteBlockPost.mockResolvedValue({
      postId: 5151,
      url: '/posts/5151',
      imageIds: [1],
      modelVersionId: null,
      tagNames: [],
    });
    await caller().createPostFromApp(INPUT);
    expect('modelVersionId' in mockRecordScopeInvocation.mock.calls[0][0].detail).toBe(false);
  });

  it('hands the post-commit effects the VERIFIED token app id', async () => {
    // 🔴 THE OTHER SEAM. `applyBlockPostPublishEffects` forwards this to
    // `imagePostedToModelReward` as `viaAppId`, which is what suppresses a reward
    // paid to a third party on an app-composed post. The reward owns the
    // predicate and the service owns the forward; only this procedure can be
    // shown to supply the value, and supplying the wrong one — or none — makes
    // the whole control inert with nothing failing anywhere else.
    await caller().createPostFromApp(INPUT);

    expect(mockApplyEffects).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'appblk-alpha' })
    );
  });

  it('takes that app id from the TOKEN, not from a constant', async () => {
    // A hardcoded literal satisfies the case above. Re-issuing the token with a
    // different app id is what makes the argument observably derived.
    mockAuthorizeBlockBridgeToken.mockResolvedValue(claims({ appId: 'appblk-zeta' }));

    await caller().createPostFromApp(INPUT);

    expect(mockApplyEffects).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'appblk-zeta' })
    );
  });

  it('a failure in the post-commit effects does NOT fail the already-public post', async () => {
    // The post is committed by then. Throwing would invite a retry and a
    // duplicate post — strictly worse than a stale cache.
    mockApplyEffects.mockRejectedValue(new Error('redis down'));
    await expect(caller().createPostFromApp(INPUT)).resolves.toMatchObject({ postId: 5150 });
  });

  it('🔴 REFUSES when the resolved image set no longer matches what the viewer confirmed', async () => {
    // THE CASE THE AUTHORIZATION CHECKS CANNOT SEE. Preview and write resolve
    // `sources` independently, so the resolved set can differ from the one the
    // dialog rendered. Every guard still passes and the viewer gets a post
    // containing an image they were never shown.
    //
    // The KNOWN generator of that divergence — a still-running workflow gaining
    // an output — is refused upstream by the terminality gate in
    // `resolveOwnedWorkflowOutputs` (`block-post.service.test.ts` owns that red).
    // This case is DEFENCE IN DEPTH for the class: it forces the mismatch
    // directly at the service boundary, which is what a future source arm or an
    // expiring blob would do without tripping any gate above.
    mockResolveBlockPostSources.mockResolvedValue([
      { kind: 'published', imageId: 1, url: 'u', width: 1, height: 1 },
      { kind: 'published', imageId: 2, url: 'u', width: 1, height: 1 },
    ]);

    await expect(
      caller().createPostFromApp({ ...INPUT, confirmedImageCount: 1 })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'the images changed since you confirmed — please try again',
    });
    expect(mockWriteBlockPost).not.toHaveBeenCalled();
    // …and nothing was materialised, so a refused confirm leaves no orphan rows.
    expect(mockPersistImage).not.toHaveBeenCalled();
  });

  it('accepts a MATCHING confirmed count — the positive control for the check above', async () => {
    // Without this, a mutant that refused every request carrying the field would
    // pass the negative case.
    mockResolveBlockPostSources.mockResolvedValue([
      { kind: 'published', imageId: 1, url: 'u', width: 1, height: 1 },
      { kind: 'published', imageId: 2, url: 'u', width: 1, height: 1 },
    ]);
    await expect(
      caller().createPostFromApp({ ...INPUT, confirmedImageCount: 2 })
    ).resolves.toMatchObject({ postId: 5150 });
  });

  it('🔴 the confirmed count is REQUIRED — a caller cannot decline the check', async () => {
    // The point of making it required. An integrity check a future caller may
    // omit is a suggestion, not an invariant: it would be declined by exactly
    // the callers least likely to have rendered a dialog. Omitting it now fails
    // input validation, before the procedure body runs at all — so no rate
    // bucket is charged and no source is resolved.
    const { confirmedImageCount: _omitted, ...withoutCount } = INPUT;

    await expect(caller().createPostFromApp(withoutCount as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockCheckPostRate).not.toHaveBeenCalled();
    expect(mockResolveBlockPostSources).not.toHaveBeenCalled();
    expect(mockWriteBlockPost).not.toHaveBeenCalled();
  });

  it('the PREVIEW does NOT require it — it is the phase that produces the number', async () => {
    // The asymmetry between the two arms, asserted so a later "harmonise the
    // shapes" change has to break a test rather than quietly demand that the
    // preview answer its own question.
    const { confirmedImageCount: _omitted, ...withoutCount } = INPUT;
    await expect(caller().previewPostFromApp(withoutCount as never)).resolves.toBeDefined();
  });

  it('audits a refusal that happens AFTER the rate bucket admitted the call', async () => {
    // The audit window starts at admission, so a downstream refusal — here a
    // provenance failure in source resolution — still produces a row. Without
    // this, only successes and write-failures would be visible to a sweep.
    mockResolveBlockPostSources.mockRejectedValue(new Error('an image is not available to post'));

    await expect(caller().createPostFromApp(INPUT)).rejects.toThrow(
      'an image is not available to post'
    );
    expect(mockRecordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        detail: expect.objectContaining({ action: 'post.create', outcome: 'failed' }),
      })
    );
  });

  it('does NOT audit a refusal from BEFORE admission — those rows would be unbounded', async () => {
    // The deliberate limit of the window above, asserted so it reads as a
    // decision rather than an oversight: a refused app must not be able to fill
    // the viewer's activity feed with rows for actions that never happened.
    mockCheckPostRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    await expect(caller().createPostFromApp(INPUT)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(mockRecordScopeInvocation).not.toHaveBeenCalled();
  });

  it('returns exactly { postId, url, imageIds } — the SDK reply contract', async () => {
    await expect(caller().createPostFromApp(INPUT)).resolves.toEqual({
      postId: 5150,
      url: '/posts/5150',
      imageIds: [501],
    });
  });
});
