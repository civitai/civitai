import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolveRedetection,
  setModelMinorFlag,
  dismissMinorHashMatch,
  getNeedsReviewModels,
  getNeedsReviewCount,
  getMinorQueueCounts,
  getHeldDetectionModelCount,
  getModelFlagState,
  setModelPoiFlag,
  dismissPoiHashMatch,
} = vi.hoisted(() => ({
  getModelFlagState: vi.fn(),
  resolveRedetection: vi.fn(),
  setModelMinorFlag: vi.fn(),
  dismissMinorHashMatch: vi.fn(),
  setModelPoiFlag: vi.fn(),
  dismissPoiHashMatch: vi.fn(),
  getNeedsReviewModels: vi.fn(),
  getNeedsReviewCount: vi.fn(),
  getMinorQueueCounts: vi.fn(),
  getHeldDetectionModelCount: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({
  getNeedsReviewModels,
  getNeedsReviewCount,
  getMinorQueueCounts,
  getHeldDetectionModelCount,
  getModelFlagState,
}));
vi.mock('$lib/server/minor-flag.service', () => ({
  confirmMinorFlag: vi.fn(),
  dismissMinorHashMatch,
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
  resolveRedetection,
  revertMinorFlag: vi.fn(),
  ruleTextScanFlag: vi.fn(),
  setModelMinorFlag,
  setModelPoiFlag,
  dismissPoiHashMatch,
}));

const { actions, load } = await import('../+page.server');

const BOTH = {
  'modelFlags.detections.decide': true,
  'modelFlags.fileMatches.decide': true,
} as const;
type Grants = Record<string, true>;

type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];
const decide = (
  flags: object[],
  keep: string,
  extra: Record<string, string> = {},
  grants: Grants = BOTH
) => {
  const body = new FormData();
  const fields = { modelId: '42', flags: JSON.stringify(flags), keep, ...extra };
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const event = {
    request: new Request('http://x/models/flags/needs-review', { method: 'POST', body }),
    locals: { grants },
  };
  return actions!.decideFlags(event as unknown as ActionEvent) as Promise<Record<string, unknown>>;
};

const held = { label: 'minor', source: 'redetected', textHash: 'h-1' };
const heldPoi = { label: 'poi', source: 'redetected', textHash: 'h-1' };
const match = { label: 'minor', source: 'file-match', textHash: null };
const kept = { resolvedReason: 'detection-correct' };
const dismissed = { resolvedReason: 'not-a-minor' };

beforeEach(() => {
  vi.clearAllMocks();
  resolveRedetection.mockResolvedValue({ ok: true, resolved: 'kept' });
  setModelMinorFlag.mockResolvedValue({ ok: true });
  dismissMinorHashMatch.mockResolvedValue({ ok: true });
  getNeedsReviewModels.mockResolvedValue({ items: [], hasMore: false });
  getNeedsReviewCount.mockResolvedValue(4);
  getMinorQueueCounts.mockResolvedValue({ pending: 10, pendingWithDetection: 1 });
  getHeldDetectionModelCount.mockResolvedValue(3);
  setModelPoiFlag.mockResolvedValue({ ok: true });
  dismissPoiHashMatch.mockResolvedValue({ ok: true });
  getModelFlagState.mockResolvedValue({ minor: false, poi: false });
});

describe('held detections', () => {
  it('flags with the label, the text the moderator saw and the reason', async () => {
    expect(await decide([heldPoi], 'poi:redetected', kept)).toMatchObject({
      success: true,
      modelId: 42,
      resolved: 'kept',
    });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'poi', true, 'h-1', {
      resolvedReason: 'detection-correct',
      internalNotes: undefined,
    });
  });

  it("doesn't flag: dismisses with the reason and note", async () => {
    await decide([held], '', { resolvedReason: 'other', internalNotes: 'a cartoon' });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'minor', false, 'h-1', {
      resolvedReason: 'other',
      internalNotes: 'a cartoon',
    });
  });

  it.each([
    ['no reason', [held], 'minor:redetected', {}],
    ['a dismissal reason on a flag', [held], 'minor:redetected', dismissed],
    ['Other without a note', [held], '', { resolvedReason: 'other' }],
    ['a reason bound to the other label', [heldPoi], '', dismissed],
    ['no text hash', [{ ...held, textHash: null }], '', dismissed],
  ])('refuses %s before calling the main app', async (_name, flags, keep, extra) => {
    expect(await decide(flags, keep, extra as Record<string, string>)).toMatchObject({
      status: 400,
    });
    expect(resolveRedetection).not.toHaveBeenCalled();
  });
});

describe('file matches', () => {
  it('flags as minor through set-minor, with no reason to record', async () => {
    expect(await decide([match], 'minor:file-match')).toMatchObject({
      success: true,
      resolved: 'kept',
    });
    expect(setModelMinorFlag).toHaveBeenCalledWith(42);
    expect(dismissMinorHashMatch).not.toHaveBeenCalled();
  });

  it('dismisses the match', async () => {
    expect(await decide([match], '')).toMatchObject({ success: true, resolved: 'dismissed' });
    expect(dismissMinorHashMatch).toHaveBeenCalledWith(42);
  });

  it('refuses to set minor on a model already flagged minor some other way', async () => {
    getModelFlagState.mockResolvedValue({ minor: true, poi: false });
    expect(await decide([match], 'minor:file-match')).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/already flagged as minor/) },
    });
    expect(setModelMinorFlag).not.toHaveBeenCalled();
  });
});

describe('real-person file matches', () => {
  const poiMatch = { label: 'poi', source: 'file-match', textHash: null };

  it('flags through set-poi, never the minor path', async () => {
    expect(await decide([poiMatch], 'poi:file-match')).toMatchObject({
      success: true,
      resolved: 'kept',
    });
    expect(setModelPoiFlag).toHaveBeenCalledWith(42);
    expect(setModelMinorFlag).not.toHaveBeenCalled();
    expect(dismissPoiHashMatch).not.toHaveBeenCalled();
  });

  it('dismisses through the real-person dismiss, never the minor one', async () => {
    expect(await decide([poiMatch], '')).toMatchObject({ success: true, resolved: 'dismissed' });
    expect(dismissPoiHashMatch).toHaveBeenCalledWith(42);
    expect(dismissMinorHashMatch).not.toHaveBeenCalled();
  });

  it('refuses to set the flag on a model already flagged as a real person', async () => {
    getModelFlagState.mockResolvedValue({ minor: false, poi: true });
    expect(await decide([poiMatch], 'poi:file-match')).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/already flagged as real person/) },
    });
    expect(setModelPoiFlag).not.toHaveBeenCalled();
  });

  it('a minor flag does not settle a real-person match', async () => {
    getModelFlagState.mockResolvedValue({ minor: true, poi: false });
    await decide([poiMatch], 'poi:file-match');
    expect(setModelPoiFlag).toHaveBeenCalledWith(42);
  });

  it('a kept real-person detection settles its match without setting the flag twice', async () => {
    let poi = false;
    resolveRedetection.mockImplementation(async () => {
      poi = true;
      return { ok: true, resolved: 'kept' };
    });
    getModelFlagState.mockImplementation(async () => ({ minor: false, poi }));
    expect(await decide([heldPoi, poiMatch], 'poi:redetected,poi:file-match', kept)).toMatchObject({
      success: true,
      resolved: 'kept',
    });
    expect(setModelPoiFlag).not.toHaveBeenCalled();
  });

  it('rules each label of a row carrying both matches through its own path', async () => {
    await decide([match, poiMatch], 'poi:file-match');
    expect(setModelPoiFlag).toHaveBeenCalledWith(42);
    expect(dismissMinorHashMatch).toHaveBeenCalledWith(42);
    expect(setModelMinorFlag).not.toHaveBeenCalled();
    expect(dismissPoiHashMatch).not.toHaveBeenCalled();
  });

  it('is refused to a viewer without the file-match permission', async () => {
    const result = await decide([poiMatch], '', {}, { 'modelFlags.detections.decide': true });
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/Flag or dismiss file matches/) },
    });
    expect(dismissPoiHashMatch).not.toHaveBeenCalled();
  });
});

describe('a model with a held minor detection and a file match', () => {
  // A fake main app: keeping the held minor detection applies the minor flag (with no hash snapshot).
  const keepAppliesMinor = () => {
    let minor = false;
    resolveRedetection.mockImplementation(async () => {
      minor = true;
      return { ok: true, resolved: 'kept' };
    });
    getModelFlagState.mockImplementation(async () => ({ minor, poi: false }));
  };

  it('flags both by keeping the detection alone: set-minor would snapshot the flagged state', async () => {
    keepAppliesMinor();
    expect(await decide([held, match], 'minor:redetected,minor:file-match', kept)).toMatchObject({
      success: true,
      modelId: 42,
      resolved: 'kept',
    });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'minor', true, 'h-1', expect.anything());
    expect(setModelMinorFlag).not.toHaveBeenCalled();
  });

  it('still sets minor for the match when keeping the detection failed', async () => {
    resolveRedetection.mockResolvedValue({ ok: false, error: 'Reload the queue.' });
    expect(await decide([held, match], 'minor:redetected,minor:file-match', kept)).toMatchObject({
      status: 400,
      data: {
        error: 'Minor (held detection) not ruled: Reload the queue. Minor (file match) flagged.',
        partial: true,
      },
    });
    expect(setModelMinorFlag).toHaveBeenCalledWith(42);
  });

  it('names what landed when the match fails after the detection was ruled', async () => {
    dismissMinorHashMatch.mockResolvedValue({ ok: false, error: 'Gone.' });
    resolveRedetection.mockResolvedValue({ ok: true, resolved: 'dismissed' });
    expect(await decide([held, match], '', dismissed)).toMatchObject({
      status: 400,
      data: {
        error: 'Minor (file match) not ruled: Gone. Minor (held detection) dismissed.',
        partial: true,
      },
    });
  });
});

it('reports the lead that was applied, not "already flagged", when another lead found nothing to do', async () => {
  resolveRedetection
    .mockResolvedValueOnce({ ok: true, resolved: 'closed' })
    .mockResolvedValueOnce({ ok: true, resolved: 'kept' });
  expect(
    await decide([held, heldPoi], 'minor:redetected,poi:redetected', {
      resolvedReason: 'other',
      internalNotes: 'x',
    })
  ).toMatchObject({ success: true, resolved: 'kept' });
});

describe('permissions', () => {
  it('refuses a held detection to a viewer without its permission, before any write', async () => {
    const result = await decide([held, match], '', dismissed, {
      'modelFlags.fileMatches.decide': true,
    });
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/Flag or dismiss held text-scan detections/) },
    });
    expect(resolveRedetection).not.toHaveBeenCalled();
    expect(dismissMinorHashMatch).not.toHaveBeenCalled();
  });

  it('refuses a file match to a viewer without its permission', async () => {
    const result = await decide([match], '', {}, { 'modelFlags.detections.decide': true });
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/Flag or dismiss file matches/) },
    });
    expect(dismissMinorHashMatch).not.toHaveBeenCalled();
  });

  it("refuses an applied flag: those are Auto-flagged's", async () => {
    const hash = { label: 'minor', source: 'hash', textHash: null };
    expect(await decide([hash], '')).toMatchObject({ status: 400 });
  });
});

describe('queue load', () => {
  type Loaded = {
    sources: { detections: boolean; matches: boolean };
    total: number | undefined;
    chipCounts: Record<string, number>;
    items: unknown[];
  };
  const loadQueue = async (query = '', grants: Grants = BOTH) =>
    (await (load as unknown as (e: { url: URL; locals: unknown }) => Promise<Loaded>)({
      url: new URL(`http://x/models/flags/needs-review${query}`),
      locals: { grants },
    })) as Loaded;

  it('lists only the kinds of lead the viewer may rule', async () => {
    const loaded = await loadQueue('', { 'modelFlags.fileMatches.decide': true });
    expect(loaded.sources).toEqual({ detections: false, matches: true });
    expect(getNeedsReviewModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ sources: { detections: false, matches: true } })
    );
  });

  it('totals both kinds in models from the counts, a model with both once', async () => {
    expect((await loadQueue()).total).toBe(12);
    expect(getNeedsReviewCount).not.toHaveBeenCalled();
  });

  it('counts held detections exactly when no file match is listed', async () => {
    expect((await loadQueue('?source=text-scan&q=bob')).total).toBe(4);
    expect(getNeedsReviewCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: { text: 'bob' } })
    );
  });

  it('offers no total for a searched list with file matches in it', async () => {
    expect((await loadQueue('?q=bob')).total).toBeUndefined();
  });

  it('counts each source chip from the same parts, whichever chip is active', async () => {
    const counts = { all: 12, 'text-scan': 3, hash: 10 };
    expect((await loadQueue()).chipCounts).toEqual(counts);
    expect((await loadQueue('?source=hash')).chipCounts).toEqual(counts);
    expect((await loadQueue('?source=hash')).total).toBe(10);
    expect((await loadQueue('?q=bob')).chipCounts).toEqual({});
    expect((await loadQueue('?flag=poi')).chipCounts).toEqual({});
  });

  it('drops a chip count whose query ran past the budget', async () => {
    getMinorQueueCounts.mockRejectedValue(new Error('slow'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = await loadQueue();
    expect(loaded.chipCounts).toEqual({ 'text-scan': 3 });
    expect(loaded.total).toBeUndefined();
  });

  it('passes the filters through, ignoring unknown values', async () => {
    await loadQueue('?source=hash&flag=minor&sort=newest');
    expect(getNeedsReviewModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { source: 'hash', flag: 'minor', sort: 'newest' } })
    );
    await loadQueue('?source=redetected&flag=x');
    expect(getNeedsReviewModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { source: 'all', flag: 'all', sort: 'oldest' } })
    );
  });
});
