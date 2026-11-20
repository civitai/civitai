import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as BlobRatings from '~/server/services/orchestrator/blobRatings';
import type { BlobState } from '~/server/services/orchestrator/blobRatings';
import type { BlockOutputWorkflowFacts } from '~/server/services/blocks/block-output-restriction';

// The media route reads the brake per viewer and the blob's current state; both are faked so
// the route side of each parity row runs the real `judgeTicket`.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: async () => undefined,
  isFliptSync: (flag: string) => flag === 'app-blocks-workflow-media-serve',
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: async (id: number) => ({ id, tier: 'free' }) },
}));
const blobState = vi.fn<(blobId: string) => Promise<BlobState>>();
vi.mock('~/server/services/orchestrator/blobRatings', async (importOriginal) => ({
  ...(await importOriginal<typeof BlobRatings>()),
  readBlobState: (blobId: string) => blobState(blobId),
}));

const { snapshotFromWorkflow, projectAppWorkflowWithPositions, BLOCK_STEP_NAME } = await import(
  '~/server/services/blocks/workflow.service'
);
const { blockOutputCeilingFromClaims, classifyBlockOutput } = await import(
  '~/server/services/blocks/block-output-restriction'
);
const { mintBlockOutput, applyServingRules, applyServingOffRules } = await import(
  '~/server/services/blocks/block-output-mint'
);
const { openBlockMediaRef, openBlockMediaTicket, sealBlockMediaTicket } = await import(
  '~/server/services/blocks/block-media-token'
);
const { resolveBlockMediaFetch } = await import('~/server/services/blocks/block-media-serving');
const { NsfwLevel } = await import('~/server/common/enums');
const { allBrowsingLevelsFlag } = await import('~/shared/constants/browsingLevel.constants');

const VIEWER = 7;
const APP = 'apb_1';
const CONTENT = 'https://content.example/served';
const TICKET_PREFIX = '/api/v1/blocks/media/';

const blobUrl = (id: string) => `https://orch.example/v2/consumer/blobs/${id}?sig=s&exp=e`;
const PG13 = NsfwLevel.PG | NsfwLevel.PG13;

/** The view an app-facing read builds for a signed-in viewer at `viewerLevel`. */
const viewAt = (viewerLevel: number, minting = true) => ({
  ...blockOutputCeilingFromClaims({
    sub: `user:${VIEWER}`,
    maxBrowsingLevel: allBrowsingLevelsFlag,
    viewerBrowsingLevel: viewerLevel,
  }),
  serving: minting,
  mint: minting ? { userId: VIEWER, appBlockId: APP } : null,
});
const SERVING = viewAt(allBrowsingLevelsFlag);
const OFF = viewAt(allBrowsingLevelsFlag, false);

type Blob = Record<string, unknown>;
const image = (id: string, nsfwLevel: string | null, over: Blob = {}): Blob => ({
  id,
  type: 'image',
  url: blobUrl(id),
  available: true,
  width: 512,
  height: 512,
  ...(nsfwLevel === null ? {} : { nsfwLevel }),
  ...over,
});
const mesh = (id: string, nsfwLevel: string): Blob => ({
  id,
  type: 'model3d',
  url: blobUrl(id),
  available: true,
  format: 'glb',
  nsfwLevel,
});

function wf(steps: Blob[], over: Blob = {}): Parameters<typeof snapshotFromWorkflow>[0] {
  return {
    id: 'wf_m',
    createdAt: '2026-11-17T00:00:00.000Z',
    status: 'succeeded',
    metadata: {},
    tags: [],
    cost: { total: 8 },
    steps,
    ...over,
  } as never;
}
const textToImage = (images: Blob[]): Blob => ({
  $type: 'textToImage',
  name: 's1',
  status: 'succeeded',
  metadata: {},
  output: { images },
});
const videoStep = (video: Blob, engine = 'wan'): Blob => ({
  $type: 'videoGen',
  name: BLOCK_STEP_NAME,
  status: 'succeeded',
  metadata: {},
  input: { engine },
  output: { video },
});
const video = (id: string, nsfwLevel: string | null): Blob => ({
  id,
  type: 'video',
  url: blobUrl(id),
  available: true,
  ...(nsfwLevel === null ? {} : { nsfwLevel }),
});
const meshStep = (model: Blob): Blob => ({
  $type: 'meshGen',
  name: BLOCK_STEP_NAME,
  status: 'succeeded',
  output: { model },
});

const ticketOf = (url: string) => url.slice(TICKET_PREFIX.length);
const rated = (nsfwLevel: string, blockedReason: string | null = null): BlobState => ({
  verdict: 'rated',
  nsfwLevel,
  blockedReason,
  location: CONTENT,
});

beforeEach(() => blobState.mockReset());

describe('serving off: the read is what it was before serving existed', () => {
  const workflow = wf([
    textToImage([image('p1', 'pg'), image('r1', 'r')]),
    meshStep(mesh('g1', 'pg')),
  ]);

  it('snapshot: orchestrator urls, no mediaRef', () => {
    const snap = snapshotFromWorkflow(workflow, OFF);
    expect(snap.imageUrls).toStrictEqual([blobUrl('p1'), blobUrl('r1'), blobUrl('g1')]);
    expect(snap.outputs).toStrictEqual([
      { url: blobUrl('p1'), nsfwLevel: 'pg' },
      { url: blobUrl('r1'), nsfwLevel: 'r' },
      { url: blobUrl('g1'), nsfwLevel: 'pg' },
    ]);
    expect(snap.model3dOutputs?.map((m) => m.url)).toStrictEqual([blobUrl('g1')]);
    expect(JSON.stringify(snap)).not.toContain('mediaRef');
    expect(JSON.stringify(snap)).not.toContain(TICKET_PREFIX);
  });

  it('listing: orchestrator urls in images and outputs', () => {
    const { workflow: listed } = projectAppWorkflowWithPositions(workflow, OFF);
    expect(listed.images.map((i) => i.url)).toStrictEqual([
      blobUrl('p1'),
      blobUrl('r1'),
      blobUrl('g1'),
    ]);
    expect(JSON.stringify(listed)).not.toContain('mediaRef');
    expect(JSON.stringify(listed)).not.toContain(TICKET_PREFIX);
  });
});

describe('serving on: every url the app is given is a ticket', () => {
  const workflow = wf(
    [textToImage([image('p1', 'pg'), image('x1', 'x')]), meshStep(mesh('g1', 'pg'))],
    { metadata: { isPrivateGeneration: true } }
  );

  it('snapshot: imageUrls, outputs and model3dOutputs carry tickets, never an orchestrator url', () => {
    const snap = snapshotFromWorkflow(workflow, SERVING);
    expect(snap.imageUrls).toHaveLength(3);
    for (const url of snap.imageUrls!) expect(url.startsWith(TICKET_PREFIX)).toBe(true);
    expect(snap.outputs?.map((o) => ('url' in o ? o.url : null))).toStrictEqual(snap.imageUrls);
    expect(snap.outputs?.every((o) => 'mediaRef' in o)).toBe(true);
    expect(snap.model3dOutputs?.map((m) => m.url)).toStrictEqual([snap.imageUrls![2]]);
    expect(JSON.stringify(snap)).not.toContain('orch.example');
  });

  it('listing: images carry the tickets; server-side positions keep the orchestrator url', () => {
    const { workflow: listed, positions } = projectAppWorkflowWithPositions(workflow, SERVING);
    for (const i of listed.images) expect(i.url.startsWith(TICKET_PREFIX)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('orch.example');
    expect(positions.map((p) => p.image.url)).toStrictEqual([
      blobUrl('p1'),
      blobUrl('x1'),
      blobUrl('g1'),
    ]);
  });

  it('the ticket names the blob, the viewer as owner, the app, the type and the poll level', () => {
    const snap = snapshotFromWorkflow(workflow, SERVING);
    const ticket = openBlockMediaTicket(ticketOf(snap.imageUrls![0]));
    expect(ticket).toMatchObject({
      blobId: 'p1',
      workflowId: 'wf_m',
      ownerId: VIEWER,
      viewerId: VIEWER,
      appBlockId: APP,
      mediaType: 'image',
      privateGen: true,
      neverRatedVideoStep: false,
      viewerBrowsingLevel: SERVING.maxBrowsingLevel,
    });
    expect(openBlockMediaTicket(ticketOf(snap.imageUrls![2]))?.mediaType).toBe('model3d');
  });

  it('the mediaRef opens only as a ref, and carries no viewer', () => {
    const output = snapshotFromWorkflow(workflow, SERVING).outputs![0] as { mediaRef: string };
    const ref = openBlockMediaRef(output.mediaRef);
    expect(ref).toMatchObject({ blobId: 'p1', ownerId: VIEWER, appBlockId: APP });
    expect(ref).not.toHaveProperty('viewerId');
    expect(openBlockMediaTicket(output.mediaRef)).toBeNull();
  });

  it('an url with no consumer blob id is restricted, never passed through', () => {
    const odd = image('odd', 'pg', { url: 'https://cdn.example/odd.png' });
    const snap = snapshotFromWorkflow(wf([textToImage([odd])]), SERVING);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrecognised_url' }]);
    expect(snap).not.toHaveProperty('imageUrls');
    expect(JSON.stringify(snap)).not.toContain('cdn.example');
  });

  it('CONTROL: the same odd url passes through with serving off', () => {
    const odd = image('odd', 'pg', { url: 'https://cdn.example/odd.png' });
    expect(snapshotFromWorkflow(wf([textToImage([odd])]), OFF).imageUrls).toStrictEqual([
      'https://cdn.example/odd.png',
    ]);
  });
});

describe('🔴 the poll and the route agree on what serving hides', () => {
  /** What the route answers for the ticket the poll would mint if it minted one. */
  const routeFor = async (
    blob: BlobState,
    claims: { mediaType: 'image' | 'video'; neverRatedVideoStep: boolean; level?: number }
  ) => {
    blobState.mockResolvedValue(blob);
    return resolveBlockMediaFetch(
      sealBlockMediaTicket({
        blobId: 'b1',
        workflowId: 'wf_m',
        ownerId: VIEWER,
        appBlockId: APP,
        privateGen: false,
        mediaType: claims.mediaType,
        neverRatedVideoStep: claims.neverRatedVideoStep,
        viewerId: VIEWER,
        viewerBrowsingLevel: claims.level ?? SERVING.maxBrowsingLevel,
      })
    );
  };

  it('D1: an unrated video from a never-rated engine is restricted on the poll and hidden on the route', async () => {
    const snap = snapshotFromWorkflow(wf([videoStep(video('k1', null), 'kling')]), SERVING);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrated' }]);
    expect(snap).not.toHaveProperty('imageUrls');
    expect(
      await routeFor(rated('pg'), { mediaType: 'video', neverRatedVideoStep: true })
    ).toStrictEqual({ state: 'hidden', reason: 'unrated' });
  });

  it('D1: a RATED video from a never-rated engine is restricted on the poll too', () => {
    const snap = snapshotFromWorkflow(wf([videoStep(video('k1', 'pg'), 'kling')]), SERVING);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrated' }]);
  });

  it('with serving off the never-rated video is restricted too, with no url', () => {
    const snap = snapshotFromWorkflow(wf([videoStep(video('k1', null), 'kling')]), OFF);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrated' }]);
    expect(JSON.stringify(snap)).not.toContain('orch.example');
  });

  it('with serving off an unrated video from a rated engine is held, for an all-ratings viewer too', () => {
    const snap = snapshotFromWorkflow(wf([videoStep(video('w0', null), 'wan')]), OFF);
    expect(snap.outputs).toStrictEqual([{ pending: true }]);
    expect(JSON.stringify(snap)).not.toContain('orch.example');
  });

  it('with serving off a RATED video from a never-rated engine is restricted too', () => {
    const snap = snapshotFromWorkflow(wf([videoStep(video('k2', 'pg'), 'kling')]), OFF);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrated' }]);
  });

  it('CONTROL: with serving off a rated video from a rated engine keeps its url', () => {
    const snap = snapshotFromWorkflow(wf([videoStep(video('w1', 'pg'), 'wan')]), OFF);
    expect(snap.imageUrls).toStrictEqual([blobUrl('w1')]);
  });

  it('CONTROL: a rated video from an engine that is rated gets a ticket the route serves', async () => {
    const snap = snapshotFromWorkflow(wf([videoStep(video('w1', 'pg'), 'wan')]), SERVING);
    expect(snap.imageUrls?.[0].startsWith(TICKET_PREFIX)).toBe(true);
    blobState.mockResolvedValue(rated('pg'));
    expect(await resolveBlockMediaFetch(ticketOf(snap.imageUrls![0]))).toStrictEqual({
      state: 'redirect',
      location: CONTENT,
    });
  });

  it('`na`: restricted on the poll, hidden on the route', async () => {
    const snap = snapshotFromWorkflow(wf([textToImage([image('n1', 'na')])]), SERVING);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrated' }]);
    expect(
      await routeFor(rated('na'), { mediaType: 'image', neverRatedVideoStep: false })
    ).toStrictEqual({ state: 'hidden', reason: 'unrated' });
  });

  it('with serving off `na` is restricted too', () => {
    const snap = snapshotFromWorkflow(wf([textToImage([image('n1', 'na')])]), OFF);
    expect(snap.outputs).toStrictEqual([{ restricted: true, reason: 'unrated' }]);
    expect(JSON.stringify(snap)).not.toContain('orch.example');
  });

  it('with serving off an output of an unknown blob type is restricted, as with serving on', () => {
    const shown = { url: blobUrl('u1') } as const;
    const slot = { url: blobUrl('u1'), type: 'movie', nsfwLevel: null };
    expect(applyServingOffRules(shown, slot, { neverRatedVideoStep: false })).toStrictEqual({
      restricted: true,
      reason: 'unrecognised_url',
    });
  });

  it("CONTROL: with serving off the owner's `na` audio keeps its url", () => {
    const AUDIO = { url: blobUrl('a1'), type: 'audio', nsfwLevel: 'na' };
    const shown = { url: blobUrl('a1') } as const;
    expect(applyServingOffRules(shown, AUDIO, { neverRatedVideoStep: false })).toStrictEqual(shown);
  });

  it('the floor: a PG-only viewer is shown PG-13 on the poll, and the ticket serves it', async () => {
    const pgOnly = viewAt(NsfwLevel.PG);
    expect(pgOnly.maxBrowsingLevel).toBe(PG13);
    const snap = snapshotFromWorkflow(wf([textToImage([image('t1', 'pg13')])]), pgOnly);
    blobState.mockResolvedValue(rated('pg13'));
    expect(await resolveBlockMediaFetch(ticketOf(snap.imageUrls![0]))).toStrictEqual({
      state: 'redirect',
      location: CONTENT,
    });
  });

  it('CONTROL: a ticket at the raw PG level would refuse that same clip', async () => {
    expect(
      await routeFor(rated('pg13'), {
        mediaType: 'image',
        neverRatedVideoStep: false,
        level: NsfwLevel.PG,
      })
    ).toStrictEqual({ state: 'hidden', reason: 'above_level' });
  });
});

/**
 * One image's facts through BOTH decisions with serving on: the poll (`classifyBlockOutput`
 * then `mintBlockOutput`) and the route (`judgeTicket`: the blob HEAD's `NA` rule, then
 * `deriveOutputGate`), for the same rating, block and viewer level. `visible` on the poll
 * must never meet a route that refuses; the rows where they differ are the documented ones.
 */
describe('parity: classifyBlockOutput and deriveOutputGate over one fixture table', () => {
  type Verdict = 'visible' | 'hidden' | 'pending';
  const ALL = allBrowsingLevelsFlag;
  const rows: Array<{
    name: string;
    rating: string | null;
    blocked?: string;
    level: number;
    workflow?: { allowMatureContent?: boolean; nsfwLevel?: string };
    poll: Verdict;
    route: Verdict;
  }> = [
    { name: 'PG at PG|PG-13', rating: 'pg', level: PG13, poll: 'visible', route: 'visible' },
    { name: 'PG-13 at PG|PG-13', rating: 'pg13', level: PG13, poll: 'visible', route: 'visible' },
    { name: 'R at PG|PG-13', rating: 'r', level: PG13, poll: 'hidden', route: 'hidden' },
    { name: 'XXX at PG|PG-13', rating: 'xxx', level: PG13, poll: 'hidden', route: 'hidden' },
    { name: 'R at all levels', rating: 'r', level: ALL, poll: 'visible', route: 'visible' },
    { name: 'XXX at all levels', rating: 'xxx', level: ALL, poll: 'visible', route: 'visible' },
    { name: 'unknown rating', rating: 'zz', level: ALL, poll: 'hidden', route: 'hidden' },
    { name: 'na', rating: 'na', level: ALL, poll: 'hidden', route: 'hidden' },
    {
      name: 'blocked',
      rating: 'pg',
      blocked: 'Moderated',
      level: ALL,
      poll: 'hidden',
      route: 'hidden',
    },
    {
      name: 'MatureContent block',
      rating: 'r',
      blocked: 'MatureContent',
      level: ALL,
      poll: 'hidden',
      route: 'hidden',
    },
    {
      name: 'unrated, could restrict',
      rating: null,
      level: PG13,
      poll: 'pending',
      route: 'pending',
    },
    // Documented: nothing could restrict it, so the poll hands a ticket; the route answers
    // pending until the rating lands, then judges it.
    {
      name: 'unrated, cannot restrict',
      rating: null,
      level: ALL,
      poll: 'visible',
      route: 'pending',
    },
    // Documented: the poll is stricter. The route never sees the workflow's own cap or flag,
    // and the poll mints nothing for these, so no ticket exists to disagree.
    {
      name: 'R over a PG-13 workflow cap',
      rating: 'r',
      level: ALL,
      workflow: { nsfwLevel: 'pg13' },
      poll: 'hidden',
      route: 'visible',
    },
    {
      name: 'R on allowMatureContent false',
      rating: 'r',
      level: ALL,
      workflow: { allowMatureContent: false },
      poll: 'hidden',
      route: 'visible',
    },
  ];

  it.each(rows)('$name: poll $poll, route $route', async (row) => {
    const url = blobUrl('b1');
    const polled = mintBlockOutput(
      classifyBlockOutput(
        { url, nsfwLevel: row.rating, type: 'image', blockedReason: row.blocked ?? null },
        (row.workflow ?? {}) as BlockOutputWorkflowFacts,
        { maxBrowsingLevel: row.level }
      ),
      { url, type: 'image', nsfwLevel: row.rating },
      { workflowId: 'wf_m', privateGen: false, neverRatedVideoStep: false },
      { maxBrowsingLevel: row.level, serving: true, mint: { userId: VIEWER, appBlockId: APP } }
    );
    const poll: Verdict = 'url' in polled ? 'visible' : 'pending' in polled ? 'pending' : 'hidden';

    blobState.mockResolvedValue(
      row.rating === null ? { verdict: 'pending' } : rated(row.rating, row.blocked ?? null)
    );
    const fetched = await resolveBlockMediaFetch(
      sealBlockMediaTicket({
        blobId: 'b1',
        workflowId: 'wf_m',
        ownerId: VIEWER,
        appBlockId: APP,
        mediaType: 'image',
        privateGen: false,
        neverRatedVideoStep: false,
        viewerId: VIEWER,
        viewerBrowsingLevel: row.level,
      })
    );
    const route: Verdict =
      fetched.state === 'redirect' ? 'visible' : fetched.state === 'pending' ? 'pending' : 'hidden';

    expect({ poll, route }).toStrictEqual({ poll: row.poll, route: row.route });
  });
});

describe('🔴 no serve decision: every media output is restricted, never a raw url', () => {
  const UNKNOWN = { ...OFF, servingUnknown: true as const };

  it('a PG image is restricted as unrecognised_url, with no url anywhere in the snapshot', () => {
    const snap = snapshotFromWorkflow(wf([textToImage([image('pg0', 'pg')])]), UNKNOWN);
    expect(snap.outputs?.[0]).toStrictEqual({ restricted: true, reason: 'unrecognised_url' });
    expect(snap.imageUrls ?? []).toStrictEqual([]);
    expect(JSON.stringify(snap)).not.toContain('orch.example');
  });

  it('a never-rated engine video, delivered unrated with serving off, is restricted too', () => {
    const snap = snapshotFromWorkflow(wf([videoStep(video('v0', null), 'kling')]), UNKNOWN);
    expect(snap.outputs?.[0]).toStrictEqual({ restricted: true, reason: 'unrecognised_url' });
    expect(JSON.stringify(snap)).not.toContain('orch.example');
  });

  it('CONTROL: the same PG image with serving off carries its url', () => {
    const snap = snapshotFromWorkflow(wf([textToImage([image('pg0', 'pg')])]), OFF);
    expect(snap.imageUrls).toStrictEqual([blobUrl('pg0')]);
  });
});

describe('owner-only media rated `na`: the poll keeps it, every other read refuses it', () => {
  const AUDIO = { url: blobUrl('a0'), type: 'audio', nsfwLevel: 'na' };
  const shown = { url: blobUrl('a0') } as const;
  const step = { neverRatedVideoStep: false };

  it("the owner's poll keeps it", () => {
    expect(applyServingRules(shown, AUDIO, step, { forOwner: true })).toStrictEqual(shown);
  });

  it('a publish, post or persist read (not for the owner) refuses it as unrated', () => {
    expect(applyServingRules(shown, AUDIO, step)).toStrictEqual({
      restricted: true,
      reason: 'unrated',
    });
  });

  it('CONTROL: an `na` image is refused even to its owner', () => {
    expect(
      applyServingRules(shown, { ...AUDIO, type: 'image' }, step, { forOwner: true })
    ).toStrictEqual({ restricted: true, reason: 'unrated' });
  });
});

describe('🔴 an anonymous mint (no session): tickets judge the viewer as signed out', () => {
  const ANON = {
    maxBrowsingLevel: NsfwLevel.PG,
    serving: true,
    mint: { userId: VIEWER, appBlockId: APP, anonymous: true as const },
  };

  it('a PG image ticket carries the anonymous claim and the anonymous level', () => {
    const snap = snapshotFromWorkflow(wf([textToImage([image('pg0', 'pg')])]), ANON);
    const out = snap.outputs?.[0] as { url: string };
    const ticket = openBlockMediaTicket(ticketOf(out.url));
    expect(ticket).toMatchObject({
      viewerId: VIEWER,
      viewerBrowsingLevel: NsfwLevel.PG,
      anonymous: true,
    });
  });

  it('CONTROL: a signed-in mint carries no anonymous claim', () => {
    const snap = snapshotFromWorkflow(wf([textToImage([image('pg0', 'pg')])]), SERVING);
    const out = snap.outputs?.[0] as { url: string };
    expect(openBlockMediaTicket(ticketOf(out.url))?.anonymous).toBeUndefined();
  });
});
