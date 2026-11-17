import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as BlobRatings from '~/server/services/orchestrator/blobRatings';
import type { BlobState } from '~/server/services/orchestrator/blobRatings';
import type * as UserPreferences from '~/server/services/user-preferences.service';

/**
 * The media brake. `on` alone: on for everyone. `onlyFor`: on only for that user, matched on
 * the evaluation CONTEXT's `userId` as a Flipt segment constraint reads it, so a global
 * evaluation, or one without the session context, reads off. `throws`: evaluation fails.
 */
const serving = { on: true, onlyFor: null as number | null, throws: false };
const blobState = vi.fn<(blobId: string) => Promise<BlobState>>();

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  // Only the media brake answers `serving`, so reading any other flag reads as off.
  isFlipt: async (flag: string, _entityId?: string, context?: Record<string, string>) => {
    if (flag !== 'app-blocks-workflow-media-serve') return false;
    if (serving.throws) throw new Error('flipt eval failed');
    if (serving.onlyFor !== null) return context?.userId === String(serving.onlyFor);
    return serving.on;
  },
}));
const unresolvable = new Set<number>();
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: {
    getSessionUserById: async (id: number) => (unresolvable.has(id) ? null : { id, tier: 'free' }),
  },
}));
const appAccess = vi.fn<(userId: number) => Promise<void>>();
vi.mock('~/server/services/blocks/block-token-access.service', () => ({
  assertAppBlocksEnabledForTokenUser: (userId: number) => appAccess(userId),
}));
type Relations = {
  hiddenUsers: { id: number }[];
  blockedUsers: { id: number }[];
  blockedByUsers: { id: number }[];
};
const noRelations = (): Relations => ({ hiddenUsers: [], blockedUsers: [], blockedByUsers: [] });
let relations = noRelations();
const hiddenFor = vi.fn<(args: { userId: number }) => Promise<Relations>>(async () => relations);
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  getAllHiddenForUser: (args: { userId: number }) => hiddenFor(args),
}));
vi.mock('~/server/services/orchestrator/blobRatings', async (importOriginal) => ({
  ...(await importOriginal<typeof BlobRatings>()),
  readBlobState: (blobId: string) => blobState(blobId),
}));

const {
  resolveBlockMediaFetch,
  resolveWorkflowMediaRefs,
  resolveWorkflowMediaForBlockClaims,
  resolveBlockOutputView,
} = await import('~/server/services/blocks/block-media-serving');
const { sealBlockMediaRef, sealBlockMediaTicket } = await import(
  '~/server/services/blocks/block-media-token'
);
const { NsfwLevel } = await import('~/server/common/enums');
const { allBrowsingLevelsFlag } = await import('~/shared/constants/browsingLevel.constants');

const CONTENT = 'https://orchestrator.example/content/abc';
const claims = {
  blobId: 'BLOB1',
  workflowId: 'wf-1',
  ownerId: 7,
  appBlockId: 'apb_1',
  mediaType: 'video' as const,
  privateGen: false,
  neverRatedVideoStep: false,
};
const pgTicket = () =>
  sealBlockMediaTicket({ ...claims, viewerId: 99, viewerBrowsingLevel: NsfwLevel.PG });
const allTicket = () =>
  sealBlockMediaTicket({ ...claims, viewerId: 99, viewerBrowsingLevel: allBrowsingLevelsFlag });
const rated = (nsfwLevel: string, blockedReason: string | null = null): BlobState => ({
  verdict: 'rated',
  nsfwLevel,
  blockedReason,
  location: CONTENT,
});

beforeEach(() => {
  serving.on = true;
  serving.onlyFor = null;
  serving.throws = false;
  unresolvable.clear();
  blobState.mockReset();
  appAccess.mockReset().mockResolvedValue(undefined);
  relations = noRelations();
  hiddenFor.mockClear();
});

describe('resolveBlockMediaFetch (the media route)', () => {
  it('CONTROL: a rated PG clip redirects to its content', async () => {
    blobState.mockResolvedValue(rated('pg'));
    expect(await resolveBlockMediaFetch(pgTicket())).toEqual({
      state: 'redirect',
      location: CONTENT,
    });
  });

  it('an orchestrator CSAM/minor block is refused even when the blob reads PG', async () => {
    blobState.mockResolvedValue(rated('pg', 'Csam'));
    expect(await resolveBlockMediaFetch(allTicket())).toEqual({
      state: 'hidden',
      reason: 'blocked',
    });
  });

  it('an R clip is refused for the PG viewer the ticket names, and served to an all-levels one', async () => {
    blobState.mockResolvedValue(rated('r'));
    expect(await resolveBlockMediaFetch(pgTicket())).toEqual({
      state: 'hidden',
      reason: 'above_level',
    });
    expect((await resolveBlockMediaFetch(allTicket())).state).toBe('redirect');
  });

  it('an unscanned clip is pending, not served', async () => {
    blobState.mockResolvedValue({ verdict: 'pending' });
    expect(await resolveBlockMediaFetch(allTicket())).toEqual({ state: 'pending' });
  });

  it('🔴 a blob reading `NA` is hidden as unrated, even for an all-levels viewer', async () => {
    blobState.mockResolvedValue(rated('na'));
    expect(await resolveBlockMediaFetch(allTicket())).toEqual({
      state: 'hidden',
      reason: 'unrated',
    });
  });

  describe("🔴 the ticket's owner, privacy, media type and step reach the gate", () => {
    const OWNER = claims.ownerId;
    const STRANGER = 99;
    const ticketFor = (
      viewerId: number,
      over: Partial<Parameters<typeof sealBlockMediaTicket>[0]>
    ) =>
      sealBlockMediaTicket({
        ...claims,
        ...over,
        viewerId,
        viewerBrowsingLevel: allBrowsingLevelsFlag,
      });

    it('a private mature clip is served to its owner and hidden from anyone else', async () => {
      blobState.mockResolvedValue(rated('r'));
      expect(await resolveBlockMediaFetch(ticketFor(OWNER, { privateGen: true }))).toEqual({
        state: 'redirect',
        location: CONTENT,
      });
      expect(await resolveBlockMediaFetch(ticketFor(STRANGER, { privateGen: true }))).toEqual({
        state: 'hidden',
        reason: 'private',
      });
    });

    it('an audio clip is served to its owner only', async () => {
      blobState.mockResolvedValue(rated('pg'));
      expect(await resolveBlockMediaFetch(ticketFor(OWNER, { mediaType: 'audio' }))).toEqual({
        state: 'redirect',
        location: CONTENT,
      });
      expect(await resolveBlockMediaFetch(ticketFor(STRANGER, { mediaType: 'audio' }))).toEqual({
        state: 'hidden',
        reason: 'owner_only',
      });
    });

    it('a video from a never-rated step is hidden from owner and stranger alike', async () => {
      blobState.mockResolvedValue(rated('pg'));
      for (const viewer of [OWNER, STRANGER]) {
        expect(
          await resolveBlockMediaFetch(ticketFor(viewer, { neverRatedVideoStep: true }))
        ).toEqual({ state: 'hidden', reason: 'unrated' });
      }
    });
  });

  it('a blocked blob reading `NA` is hidden as blocked', async () => {
    blobState.mockResolvedValue(rated('na', 'tos'));
    expect(await resolveBlockMediaFetch(allTicket())).toEqual({
      state: 'hidden',
      reason: 'blocked',
    });
  });

  it('a rated blob with no content location is pending, never a redirect to nowhere', async () => {
    blobState.mockResolvedValue({
      verdict: 'rated',
      nsfwLevel: 'pg',
      blockedReason: null,
      location: null,
    });
    expect(await resolveBlockMediaFetch(allTicket())).toEqual({ state: 'pending' });
  });

  it('a block that lands after the ticket was issued is refused on the next fetch', async () => {
    const ticket = allTicket();
    blobState.mockResolvedValueOnce(rated('pg'));
    expect((await resolveBlockMediaFetch(ticket)).state).toBe('redirect');
    blobState.mockResolvedValueOnce(rated('pg', 'Blocked'));
    expect(await resolveBlockMediaFetch(ticket)).toEqual({ state: 'hidden', reason: 'blocked' });
  });

  it('the kill switch hides everything without reading the blob', async () => {
    serving.on = false;
    blobState.mockResolvedValue(rated('pg'));
    expect(await resolveBlockMediaFetch(pgTicket())).toEqual({ state: 'hidden', reason: 'paused' });
    expect(blobState).not.toHaveBeenCalled();
  });

  it('refuses a ref presented as a ticket, and garbage', async () => {
    blobState.mockResolvedValue(rated('pg'));
    expect(await resolveBlockMediaFetch(sealBlockMediaRef(claims))).toEqual({
      state: 'hidden',
      reason: 'invalid',
    });
    expect(await resolveBlockMediaFetch('bm1.x.y.z')).toEqual({
      state: 'hidden',
      reason: 'invalid',
    });
    expect(blobState).not.toHaveBeenCalled();
  });
});

describe('resolveWorkflowMediaRefs (GET_WORKFLOW_MEDIA)', () => {
  const viewer = {
    appBlockId: 'apb_1',
    viewerId: 99,
    viewerBrowsingLevel: NsfwLevel.PG,
    hiddenOwnerIds: new Set<number>(),
  };

  it('a replayed ref is re-judged for the replaying viewer, not the one who stored it', async () => {
    const [item] = await resolveWorkflowMediaRefs({
      ...viewer,
      refs: [sealBlockMediaRef(claims)!],
    });
    expect(item.status).toBe('visible');
    const url = (item as { url: string }).url;
    expect(url.startsWith('/api/v1/blocks/media/bm1.')).toBe(true);

    blobState.mockResolvedValue(rated('r'));
    const ticket = url.slice('/api/v1/blocks/media/'.length);
    expect(await resolveBlockMediaFetch(ticket)).toEqual({
      state: 'hidden',
      reason: 'above_level',
    });
  });

  it('refuses a ref stored by another app (a fork reading the cache)', async () => {
    const ref = sealBlockMediaRef({ ...claims, appBlockId: 'apb_fork' })!;
    expect(await resolveWorkflowMediaRefs({ ...viewer, refs: [ref] })).toEqual([
      { status: 'hidden', reason: 'invalid' },
    ]);
  });

  it('a private generation replays for its owner only', async () => {
    const ref = sealBlockMediaRef({ ...claims, privateGen: true })!;
    expect(await resolveWorkflowMediaRefs({ ...viewer, refs: [ref] })).toEqual([
      { status: 'hidden', reason: 'private' },
    ]);
    const [own] = await resolveWorkflowMediaRefs({ ...viewer, viewerId: 7, refs: [ref] });
    expect(own.status).toBe('visible');
  });

  it('refuses a ticket presented as a ref', async () => {
    expect(await resolveWorkflowMediaRefs({ ...viewer, refs: [pgTicket()!] })).toEqual([
      { status: 'hidden', reason: 'invalid' },
    ]);
  });

  it('the kill switch pauses every ref', async () => {
    serving.on = false;
    expect(
      await resolveWorkflowMediaRefs({ ...viewer, refs: [sealBlockMediaRef(claims)!] })
    ).toEqual([{ status: 'hidden', reason: 'paused' }]);
  });
});

describe('resolveWorkflowMediaForBlockClaims (the bridge and REST body)', () => {
  const tokenClaims = {
    sub: 'user:99',
    appBlockId: 'apb_1',
    maxBrowsingLevel: allBrowsingLevelsFlag,
    viewerBrowsingLevel: NsfwLevel.PG,
  };
  const fetchAs = async (overrides: Partial<typeof tokenClaims> = {}) => {
    const { media } = await resolveWorkflowMediaForBlockClaims({
      claims: { ...tokenClaims, ...overrides },
      refs: [sealBlockMediaRef(claims)!],
    });
    expect(media[0].status).toBe('visible');
    const url = (media[0] as { url: string }).url;
    blobState.mockResolvedValue(rated('r'));
    return resolveBlockMediaFetch(url.slice('/api/v1/blocks/media/'.length));
  };

  it('🔴 the ticket carries the viewer level from the token, not the domain ceiling', async () => {
    expect(await fetchAs()).toEqual({ state: 'hidden', reason: 'above_level' });
  });

  it('CONTROL: a viewer whose token allows R is served the R clip', async () => {
    expect(await fetchAs({ viewerBrowsingLevel: allBrowsingLevelsFlag })).toEqual({
      state: 'redirect',
      location: CONTENT,
    });
  });

  it('🔴 a token with no viewer level (minted before the claim) gets PG only', async () => {
    expect(await fetchAs({ viewerBrowsingLevel: undefined })).toEqual({
      state: 'hidden',
      reason: 'above_level',
    });
  });

  it('🔴 refuses a signed-out viewer', async () => {
    await expect(
      resolveWorkflowMediaForBlockClaims({ claims: { ...tokenClaims, sub: 'anon' }, refs: [] })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('🔴 refuses when the app is not enabled for the viewer, before minting anything', async () => {
    appAccess.mockRejectedValue(new Error('app suspended'));
    await expect(
      resolveWorkflowMediaForBlockClaims({
        claims: tokenClaims,
        refs: [sealBlockMediaRef(claims)!],
      })
    ).rejects.toThrow('app suspended');
    expect(appAccess).toHaveBeenCalledWith(99);
  });
});

describe("replayed refs vs the viewer's hidden and blocked users", () => {
  const tokenClaims = {
    sub: 'user:99',
    appBlockId: 'apb_1',
    maxBrowsingLevel: allBrowsingLevelsFlag,
    viewerBrowsingLevel: allBrowsingLevelsFlag,
  };
  const replay = async (refClaims = claims, sub = tokenClaims.sub) =>
    (
      await resolveWorkflowMediaForBlockClaims({
        claims: { ...tokenClaims, sub },
        refs: [sealBlockMediaRef(refClaims)!],
      })
    ).media[0];

  // What an app gets for any ref it may not have: here, one stored by another app.
  const unavailable = async () =>
    (
      await resolveWorkflowMediaForBlockClaims({
        claims: tokenClaims,
        refs: [sealBlockMediaRef({ ...claims, appBlockId: 'apb_other' })!],
      })
    ).media[0];

  it.each(['hiddenUsers', 'blockedUsers', 'blockedByUsers'] as const)(
    "🔴 refuses a ref whose owner is in the viewer's %s, indistinguishable from any unavailable ref",
    async (relation) => {
      relations = { ...noRelations(), [relation]: [{ id: claims.ownerId }] };
      const refused = await replay();
      expect(refused.status).toBe('hidden');
      expect(refused).toEqual(await unavailable());
      expect(hiddenFor).toHaveBeenCalledWith({ userId: 99 });
    }
  );

  it('CONTROL: a ref from an owner the viewer has no relation to replays', async () => {
    relations = { ...noRelations(), blockedUsers: [{ id: 12345 }] };
    expect((await replay()).status).toBe('visible');
  });

  it("the viewer's own ref replays even when the set names them", async () => {
    relations = { ...noRelations(), blockedByUsers: [{ id: 7 }] };
    expect((await replay(claims, 'user:7')).status).toBe('visible');
  });

  it('judges each ref in a batch by its own owner', async () => {
    relations = { ...noRelations(), hiddenUsers: [{ id: 7 }] };
    const { media } = await resolveWorkflowMediaForBlockClaims({
      claims: tokenClaims,
      refs: [sealBlockMediaRef(claims)!, sealBlockMediaRef({ ...claims, ownerId: 8 })!],
    });
    expect(media.map((m) => m.status)).toEqual(['hidden', 'visible']);
  });
});

describe('a token whose viewer level is 0', () => {
  const tokenClaims = {
    sub: 'user:99',
    appBlockId: 'apb_1',
    maxBrowsingLevel: allBrowsingLevelsFlag,
  };
  const replayAt = async (viewerBrowsingLevel: number) =>
    (
      await resolveWorkflowMediaForBlockClaims({
        claims: { ...tokenClaims, viewerBrowsingLevel },
        refs: [sealBlockMediaRef(claims)!],
      })
    ).media[0];

  it('🔴 gets no ref back, not the public floor', async () => {
    expect((await replayAt(0)).status).toBe('hidden');
  });

  it('CONTROL: a PG token gets a ticket that serves a PG clip', async () => {
    const item = await replayAt(NsfwLevel.PG);
    expect(item.status).toBe('visible');
    blobState.mockResolvedValue(rated('pg'));
    const url = (item as { url: string }).url;
    expect(await resolveBlockMediaFetch(url.slice('/api/v1/blocks/media/'.length))).toEqual({
      state: 'redirect',
      location: CONTENT,
    });
  });
});

describe('🔴 the media brake is judged per viewer, at the route, on replay and on the poll', () => {
  const ticketAs = (viewerId: number) =>
    sealBlockMediaTicket({ ...claims, viewerId, viewerBrowsingLevel: NsfwLevel.PG })!;
  const replayAs = async (viewerId: number) =>
    (
      await resolveWorkflowMediaRefs({
        appBlockId: 'apb_1',
        viewerId,
        viewerBrowsingLevel: NsfwLevel.PG,
        hiddenOwnerIds: new Set<number>(),
        refs: [sealBlockMediaRef(claims)!],
      })
    )[0];
  const pollMintAs = async (viewerId: number) =>
    (
      await resolveBlockOutputView({
        sub: `user:${viewerId}`,
        appBlockId: 'apb_1',
        maxBrowsingLevel: allBrowsingLevelsFlag,
        viewerBrowsingLevel: NsfwLevel.PG,
      })
    ).mint;

  /** Every point, for one viewer: what the route, a replay and the poll each give them. */
  const pointsFor = async (viewerId: number) => ({
    route: await resolveBlockMediaFetch(ticketAs(viewerId)),
    replay: (await replayAs(viewerId)).status,
    poll: await pollMintAs(viewerId),
  });
  const PAUSED = { route: { state: 'hidden', reason: 'paused' }, replay: 'hidden', poll: null };

  beforeEach(() => blobState.mockResolvedValue(rated('pg')));

  it('on for one viewer only: that viewer is served everywhere, any other is paused everywhere', async () => {
    serving.onlyFor = 99;
    expect(await pointsFor(99)).toEqual({
      route: { state: 'redirect', location: CONTENT },
      replay: 'visible',
      poll: { userId: 99, appBlockId: 'apb_1' },
    });
    expect(await pointsFor(5)).toEqual(PAUSED);
  });

  it('an evaluation that throws reads off at every point', async () => {
    serving.throws = true;
    expect(await pointsFor(99)).toEqual(PAUSED);
  });

  it('a viewer whose session does not resolve reads off at every point', async () => {
    unresolvable.add(99);
    expect(await pointsFor(99)).toEqual(PAUSED);
  });

  it('a signed-out poll never mints', async () => {
    const view = await resolveBlockOutputView({
      sub: 'anon',
      appBlockId: 'apb_1',
      maxBrowsingLevel: allBrowsingLevelsFlag,
      viewerBrowsingLevel: NsfwLevel.PG,
    });
    expect(view.mint).toBeNull();
  });
});
