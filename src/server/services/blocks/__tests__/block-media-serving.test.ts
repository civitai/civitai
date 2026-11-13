import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as BlobRatings from '~/server/services/orchestrator/blobRatings';
import type { BlobState } from '~/server/services/orchestrator/blobRatings';

const serving = { on: true };
const blobState = vi.fn<(blobId: string) => Promise<BlobState>>();

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: async () => serving.on,
}));
const appAccess = vi.fn<(userId: number) => Promise<void>>();
vi.mock('~/server/services/blocks/block-token-access.service', () => ({
  assertAppBlocksEnabledForTokenUser: (userId: number) => appAccess(userId),
}));
vi.mock('~/server/services/orchestrator/blobRatings', async (importOriginal) => ({
  ...(await importOriginal<typeof BlobRatings>()),
  readBlobState: (blobId: string) => blobState(blobId),
}));

const { resolveBlockMediaFetch, resolveWorkflowMediaRefs, resolveWorkflowMediaForBlockClaims } =
  await import('~/server/services/blocks/block-media-serving');
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
  blobState.mockReset();
  appAccess.mockReset().mockResolvedValue(undefined);
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

  it('a blocked blob reading `NA` is hidden as blocked', async () => {
    blobState.mockResolvedValue(rated('na', 'tos'));
    expect(await resolveBlockMediaFetch(allTicket())).toEqual({
      state: 'hidden',
      reason: 'blocked',
    });
  });

  it('a rated blob with no content location is pending, never a redirect to nowhere', async () => {
    blobState.mockResolvedValue({ ...rated('pg'), location: null });
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
  const viewer = { appBlockId: 'apb_1', viewerId: 99, viewerBrowsingLevel: NsfwLevel.PG };

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
