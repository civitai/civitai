import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolveRedetection,
  ruleTextScanFlag,
  confirmMinorFlag,
  revertMinorFlag,
  getFlaggedModels,
  getFlaggedCount,
} = vi.hoisted(() => ({
  ruleTextScanFlag: vi.fn(),
  resolveRedetection: vi.fn(),
  confirmMinorFlag: vi.fn(),
  revertMinorFlag: vi.fn(),
  getFlaggedModels: vi.fn(),
  getFlaggedCount: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({
  getMinorFlagAppealGroups: vi.fn(async () => []),
  getMinorHashMatchesForReview: vi.fn(),
  getFlaggedModels,
  getFlaggedCount,
}));
vi.mock('$lib/server/minor-flag.service', () => ({
  confirmMinorFlag,
  dismissMinorHashMatch: vi.fn(),
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
  resolveRedetection,
  revertMinorFlag,
  ruleTextScanFlag,
  setModelMinorFlag: vi.fn(),
}));

const { actions, load } = await import('../+page.server');

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request('http://x/models/flags/review', { method: 'POST', body }) };
};
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];
const run = (name: string, fields: Record<string, string>) =>
  actions![name](post(fields) as unknown as ActionEvent) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  resolveRedetection.mockResolvedValue({ ok: true, resolved: 'kept' });
  ruleTextScanFlag.mockResolvedValue({ ok: true, ruled: 'kept', label: 'minor', modelId: 42 });
  confirmMinorFlag.mockResolvedValue({ ok: true });
  revertMinorFlag.mockResolvedValue({ ok: true });
  getFlaggedModels.mockResolvedValue({ items: [], hasMore: false });
  getFlaggedCount.mockResolvedValue(3);
});

const redetected = { modelId: '42', label: 'minor', source: 'redetected', textHash: 'h-1' };
const kept = { resolvedReason: 'detection-correct' };
const dismissed = { resolvedReason: 'not-a-minor' };

describe('hash flag actions', () => {
  const hash = { modelId: '42', label: 'minor', source: 'hash' };

  it('keep confirms the flag by model id and records no reason', async () => {
    expect(await run('keepFlag', { ...hash, ...kept })).toMatchObject({
      success: true,
      modelId: 42,
      resolved: 'kept',
    });
    expect(confirmMinorFlag).toHaveBeenCalledWith(42);
    expect(revertMinorFlag).not.toHaveBeenCalled();
    expect(resolveRedetection).not.toHaveBeenCalled();
  });

  it.each(['keepFlag', 'liftFlag'])('%s refuses a poi label on a hash flag', async (action) => {
    const result = await run(action, { ...hash, label: 'poi', ...kept });
    expect(result).toMatchObject({
      status: 400,
      data: { error: 'A hash flag can only be ruled as minor.', modelId: 42 },
    });
    expect(confirmMinorFlag).not.toHaveBeenCalled();
    expect(revertMinorFlag).not.toHaveBeenCalled();
  });

  it('rules a hash flag as minor even when no label is posted', async () => {
    expect(await run('keepFlag', { modelId: '42', source: 'hash', ...kept })).toMatchObject({
      success: true,
      label: 'minor',
      resolved: 'kept',
    });
    expect(confirmMinorFlag).toHaveBeenCalledWith(42);
  });

  it('lift reverts the flag by model id', async () => {
    expect(await run('liftFlag', hash)).toMatchObject({ success: true, resolved: 'dismissed' });
    expect(revertMinorFlag).toHaveBeenCalledWith(42);
    expect(confirmMinorFlag).not.toHaveBeenCalled();
  });

  it("shows the main app's refusal against the model instead of reporting success", async () => {
    confirmMinorFlag.mockResolvedValue({ ok: false, error: 'Appeal open.' });
    expect(await run('keepFlag', hash)).toMatchObject({
      status: 400,
      data: { error: 'Appeal open.', modelId: 42, subject: 'Model #42' },
    });
  });
});

describe('re-detection actions', () => {
  it('keep forwards the label, the reason and keeps', async () => {
    expect(await run('keepFlag', { ...redetected, label: 'poi', ...kept })).toMatchObject({
      success: true,
      modelId: 42,
      resolved: 'kept',
    });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'poi', true, 'h-1', {
      resolvedReason: 'detection-correct',
      internalNotes: undefined,
    });
    expect(confirmMinorFlag).not.toHaveBeenCalled();
  });

  it('hands the main app\'s "already flagged" answer to the page', async () => {
    resolveRedetection.mockResolvedValue({ ok: true, resolved: 'closed' });
    expect(await run('keepFlag', { ...redetected, ...kept })).toMatchObject({
      success: true,
      resolved: 'closed',
    });
  });

  it('lift forwards the label, the reason and note, and dismisses', async () => {
    await run('liftFlag', {
      ...redetected,
      resolvedReason: 'other',
      internalNotes: 'a cartoon',
    });
    expect(resolveRedetection).toHaveBeenCalledWith(42, 'minor', false, 'h-1', {
      resolvedReason: 'other',
      internalNotes: 'a cartoon',
    });
  });

  it.each([
    ['an unknown label', { ...redetected, label: 'nsfw', ...kept }],
    ['an unknown source', { ...redetected, source: 'other', ...kept }],
    ['no model', { label: 'minor', source: 'redetected', textHash: 'h-1', ...kept }],
    ['no text hash', { modelId: '42', label: 'minor', source: 'redetected', ...kept }],
    ['no reason', redetected],
    ['a dismissal reason', { ...redetected, ...dismissed }],
    ['Other without a note', { ...redetected, resolvedReason: 'other' }],
  ])('refuses %s on a keep before calling the main app', async (_name, fields) => {
    const result = await run('keepFlag', fields);
    expect(result).toMatchObject({ status: 400 });
    expect(resolveRedetection).not.toHaveBeenCalled();
    expect(confirmMinorFlag).not.toHaveBeenCalled();
  });

  it('refuses a reason bound to the other label', async () => {
    const result = await run('liftFlag', { ...redetected, label: 'poi', ...dismissed });
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/does not apply/) },
    });
    expect(resolveRedetection).not.toHaveBeenCalled();
  });

  it('refuses a keep reason on a dismissal', async () => {
    const result = await run('liftFlag', { ...redetected, ...kept });
    expect(result).toMatchObject({ status: 400, data: { modelId: 42 } });
    expect(resolveRedetection).not.toHaveBeenCalled();
  });

  it('shows a refusal instead of reporting success', async () => {
    resolveRedetection.mockResolvedValue({ ok: false, error: 'Reload the queue.' });
    const result = (await run('liftFlag', { ...redetected, ...dismissed })) as {
      status: number;
      data: { error: string; modelId: number };
    };
    expect(result.status).toBe(400);
    expect(result.data).toMatchObject({ error: 'Reload the queue.', modelId: 42 });
  });
});

describe('text-scan flag actions', () => {
  const textScan = { modelId: '42', label: 'minor', source: 'text-scan', textHash: 'h-1' };

  it('keep rules the flag on the text the moderator saw', async () => {
    expect(await run('keepFlag', { ...textScan, ...kept, internalNotes: 'clear' })).toMatchObject({
      success: true,
      modelId: 42,
      label: 'minor',
      resolved: 'kept',
    });
    expect(ruleTextScanFlag).toHaveBeenCalledWith({
      modelId: 42,
      label: 'minor',
      keep: true,
      textHash: 'h-1',
      reason: { resolvedReason: 'detection-correct', internalNotes: 'clear' },
    });
    expect(resolveRedetection).not.toHaveBeenCalled();
    expect(confirmMinorFlag).not.toHaveBeenCalled();
  });

  it('lift records a Lifted reason for the label and reports it', async () => {
    ruleTextScanFlag.mockResolvedValue({ ok: true, ruled: 'lifted', label: 'poi', modelId: 42 });
    expect(
      await run('liftFlag', { ...textScan, label: 'poi', resolvedReason: 'not-a-real-person' })
    ).toMatchObject({
      success: true,
      label: 'poi',
      resolved: 'lifted',
    });
    expect(ruleTextScanFlag).toHaveBeenCalledWith({
      modelId: 42,
      label: 'poi',
      keep: false,
      textHash: 'h-1',
      reason: { resolvedReason: 'not-a-real-person', internalNotes: undefined },
    });
  });

  it.each([
    ['no reason', textScan],
    ['a lift reason on a keep', { ...textScan, ...dismissed }],
    ['no text hash', { modelId: '42', label: 'minor', source: 'text-scan', ...kept }],
    ['no label', { modelId: '42', source: 'text-scan', textHash: 'h-1', ...kept }],
  ])('refuses %s before calling the main app', async (_name, fields) => {
    expect(await run('keepFlag', fields)).toMatchObject({ status: 400 });
    expect(ruleTextScanFlag).not.toHaveBeenCalled();
  });

  it("shows the main app's refusal against the model", async () => {
    ruleTextScanFlag.mockResolvedValue({ ok: false, error: 'Owner appeal is open.' });
    expect(await run('keepFlag', { ...textScan, ...kept })).toMatchObject({
      status: 400,
      data: { error: 'Owner appeal is open.', modelId: 42, subject: 'Model #42' },
    });
  });
});

describe('one decision over every flag on the model', () => {
  const minorText = { label: 'minor', source: 'text-scan', textHash: 'h-1' };
  const poiText = { label: 'poi', source: 'text-scan', textHash: 'h-1' };
  const minorHash = { label: 'minor', source: 'hash', textHash: null };
  const decide = (flags: object[], keep: string, extra: Record<string, string> = {}) =>
    run('decideFlags', { modelId: '42', flags: JSON.stringify(flags), keep, ...extra });

  it('posts the fields the action reads from the decision form', () => {
    const detail = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../FlaggedDetail.svelte'),
      'utf-8'
    );
    expect(detail).toMatch(/name="modelId"/);
    expect(detail).toMatch(/name="flags" value=\{JSON\.stringify\(flagRefs\)\}/);
    expect(detail).toMatch(/name="keep"/);
    expect(detail).toMatch(/actionHref\('decideFlags'\)/);
  });

  it('confirms both flags, each through its own path, with the one reason', async () => {
    ruleTextScanFlag.mockResolvedValue({ ok: true, ruled: 'kept' });
    expect(await decide([minorHash, poiText], 'minor:hash,poi:text-scan', kept)).toMatchObject({
      success: true,
      modelId: 42,
      resolved: 'kept',
    });
    expect(confirmMinorFlag).toHaveBeenCalledWith(42);
    expect(ruleTextScanFlag).toHaveBeenCalledWith({
      modelId: 42,
      label: 'poi',
      keep: true,
      textHash: 'h-1',
      reason: { resolvedReason: 'detection-correct', internalNotes: undefined },
    });
  });

  it('reverts both with a reason that fits both labels', async () => {
    ruleTextScanFlag.mockResolvedValue({ ok: true, ruled: 'lifted' });
    await decide([minorText, poiText], '', { resolvedReason: 'terms-misread' });
    expect(
      ruleTextScanFlag.mock.calls.map(([c]) => [c.label, c.keep, c.reason.resolvedReason])
    ).toEqual([
      ['minor', false, 'terms-misread'],
      ['poi', false, 'terms-misread'],
    ]);
  });

  it('refuses a reason that explains only one of the reverted labels, before any write', async () => {
    const result = await decide([minorText, poiText], '', dismissed);
    expect(result).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/does not apply/) },
    });
    expect(ruleTextScanFlag).not.toHaveBeenCalled();
  });

  it('splits: the reverted label records the picked reason, the kept one detection-correct', async () => {
    ruleTextScanFlag.mockResolvedValue({ ok: true, ruled: 'kept' });
    await decide([minorText, poiText], 'minor:text-scan', {
      resolvedReason: 'not-a-real-person',
      internalNotes: 'a cosplayer',
    });
    expect(ruleTextScanFlag.mock.calls.map(([c]) => [c.label, c.keep, c.reason])).toEqual([
      ['minor', true, { resolvedReason: 'detection-correct', internalNotes: 'a cosplayer' }],
      ['poi', false, { resolvedReason: 'not-a-real-person', internalNotes: 'a cosplayer' }],
    ]);
  });

  it('names the label that failed and the one that went through, and does not report success', async () => {
    revertMinorFlag.mockResolvedValue({ ok: true });
    ruleTextScanFlag.mockResolvedValue({ ok: false, error: 'Text changed; reload.' });
    const result = await decide([minorHash, poiText], '', { resolvedReason: 'not-a-real-person' });
    expect(revertMinorFlag).toHaveBeenCalledWith(42);
    expect(result).toMatchObject({
      status: 400,
      data: {
        error: 'Real person (text scan) not ruled: Text changed; reload. Minor (hash) reverted.',
        modelId: 42,
        subject: 'Model #42',
        partial: true,
      },
    });
  });

  it('names what landed when a later flag throws instead of refusing', async () => {
    confirmMinorFlag.mockResolvedValue({ ok: true });
    ruleTextScanFlag.mockRejectedValue(new Error('socket hang up'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await decide([minorHash, poiText], 'minor:hash,poi:text-scan', kept);
    expect(confirmMinorFlag).toHaveBeenCalledWith(42);
    expect(result).toMatchObject({
      status: 400,
      data: {
        error: 'Real person (text scan) not ruled: socket hang up. Minor (hash) kept.',
        modelId: 42,
        partial: true,
      },
    });
  });

  describe('a hash minor flag with a held minor re-detection', () => {
    const held = { label: 'minor', source: 'redetected', textHash: 'h-2' };
    // A fake main app: a hash ruling stamps the minor entry and strips its held detection, so a
    // re-detection ruled after it is stale.
    let detectionHeld: boolean;
    beforeEach(() => {
      detectionHeld = true;
      const hashRuling = async () => {
        detectionHeld = false;
        return { ok: true };
      };
      confirmMinorFlag.mockImplementation(hashRuling);
      revertMinorFlag.mockImplementation(hashRuling);
      resolveRedetection.mockImplementation(async () =>
        detectionHeld
          ? { ok: true, resolved: 'closed' }
          : {
              ok: false,
              error: 'This re-detection changed or was already resolved. Reload the queue.',
            }
      );
    });

    it.each([
      ['reverts', '', dismissed, revertMinorFlag],
      ['confirms', 'minor:hash,minor:redetected', kept, confirmMinorFlag],
    ] as const)(
      '%s both by ruling the re-detection before the hash flag',
      async (_n, keep, reason, hashCall) => {
        const result = await decide([minorHash, held], keep, reason);
        expect(result).toMatchObject({ success: true, modelId: 42 });
        expect(resolveRedetection.mock.invocationCallOrder[0]).toBeLessThan(
          hashCall.mock.invocationCallOrder[0]
        );
      }
    );
  });

  it('reports a refusal of every flag without calling it partial', async () => {
    confirmMinorFlag.mockResolvedValue({ ok: false, error: 'Appeal open.' });
    const result = await decide([minorHash], 'minor:hash');
    expect(result).toMatchObject({
      status: 400,
      data: { error: 'Minor (hash) not ruled: Appeal open.', partial: false },
    });
  });

  it('says "already flagged" only when the main app closed every flag', async () => {
    ruleTextScanFlag.mockResolvedValue({ ok: true, ruled: 'closed' });
    resolveRedetection.mockResolvedValue({ ok: true, resolved: 'closed' });
    const held = { label: 'minor', source: 'redetected', textHash: 'h-2' };
    expect(await decide([held, poiText], 'minor:redetected,poi:text-scan', kept)).toMatchObject({
      success: true,
      resolved: 'closed',
    });
    resolveRedetection.mockResolvedValue({ ok: true, resolved: 'kept' });
    expect(await decide([held, poiText], 'minor:redetected,poi:text-scan', kept)).toMatchObject({
      resolved: 'kept',
    });
  });

  it.each([
    ['no flags', { modelId: '42', keep: '' }],
    ['malformed flags', { modelId: '42', flags: '{', keep: '' }],
    [
      'a kept flag the form does not carry',
      { modelId: '42', flags: JSON.stringify([minorText]), keep: 'poi:text-scan', ...kept },
    ],
    ['no keep field', { modelId: '42', flags: JSON.stringify([minorText]), ...kept }],
    [
      'a poi hash flag',
      { modelId: '42', flags: JSON.stringify([{ ...minorHash, label: 'poi' }]), keep: '' },
    ],
    [
      'a text-scan flag with no hash',
      {
        modelId: '42',
        flags: JSON.stringify([{ ...minorText, textHash: null }]),
        keep: '',
        ...dismissed,
      },
    ],
    [
      'the same flag twice',
      { modelId: '42', flags: JSON.stringify([minorText, minorText]), keep: '', ...dismissed },
    ],
  ])('refuses %s before any write', async (_name, fields) => {
    expect(await run('decideFlags', fields)).toMatchObject({ status: 400 });
    expect(ruleTextScanFlag).not.toHaveBeenCalled();
    expect(confirmMinorFlag).not.toHaveBeenCalled();
    expect(revertMinorFlag).not.toHaveBeenCalled();
  });
});

describe('queue load', () => {
  type Loaded = { flaggedFilters: unknown; items: unknown[] };
  const loadQueue = async (query = '') =>
    (await (load as unknown as (e: { url: URL }) => Promise<Loaded>)({
      url: new URL(`http://x/models/flags/review${query}`),
    })) as Loaded;

  it('ignores a leftover ?view or ?tab param', async () => {
    await loadQueue('?view=appeals&tab=auto');
    expect(getFlaggedModels).toHaveBeenCalledTimes(1);
  });

  it('still serves the list when the total fails', async () => {
    getFlaggedCount.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = await loadQueue();
    expect(loaded.items).toEqual([]);
  });

  it('honours the source the held-detections redirect sends', async () => {
    await loadQueue('?source=redetected');
    expect(getFlaggedModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { source: 'redetected', flag: 'all', sort: 'oldest' } })
    );
    expect(getFlaggedCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'redetected', flag: 'all' })
    );
  });

  it('passes the filters through, ignoring unknown values', async () => {
    await loadQueue('?source=hash&flag=poi&sort=newest');
    expect(getFlaggedModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { source: 'hash', flag: 'poi', sort: 'newest' } })
    );
    await loadQueue('?source=text&flag=unflagged&sort=flagged');
    expect(getFlaggedModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { source: 'all', flag: 'all', sort: 'oldest' } })
    );
  });
});
