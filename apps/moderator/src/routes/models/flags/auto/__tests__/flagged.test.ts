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
  getFlaggedSourceCounts,
  getModelAppealState,
  resolveMinorFlagAppeal,
  resolveMinorFlagAppealPerLabel,
} = vi.hoisted(() => ({
  getModelAppealState: vi.fn(),
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
  ruleTextScanFlag: vi.fn(),
  resolveRedetection: vi.fn(),
  confirmMinorFlag: vi.fn(),
  revertMinorFlag: vi.fn(),
  getFlaggedModels: vi.fn(),
  getFlaggedSourceCounts: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/minor-hash.service', () => ({
  getMinorFlagAppealGroups: vi.fn(async () => []),
  getFlaggedModels,
  getFlaggedSourceCounts,
  getModelAppealState,
}));
vi.mock('$lib/server/minor-flag.service', () => ({
  confirmMinorFlag,
  dismissMinorHashMatch: vi.fn(),
  resolveMinorFlagAppeal,
  resolveMinorFlagAppealPerLabel,
  resolveRedetection,
  revertMinorFlag,
  ruleTextScanFlag,
  setModelMinorFlag: vi.fn(),
}));

const { actions, load } = await import('../+page.server');

const ADMIN = { user: { roles: ['moderator:admin'] }, grants: {} };
const post = (fields: Record<string, string>, locals: object = ADMIN) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { request: new Request('http://x/models/flags/auto', { method: 'POST', body }), locals };
};
type ActionEvent = Parameters<NonNullable<typeof actions>[string]>[0];
const run = (name: string, fields: Record<string, string>, locals?: object) =>
  actions![name](post(fields, locals) as unknown as ActionEvent) as Promise<
    Record<string, unknown>
  >;

/** What `getModelAppealState` reads: the flags the model carries and the text each text-scan flag is bound to. */
const appealState = (over: object = {}) => ({
  pendingAppeal: true,
  minor: true,
  poi: false,
  textScan: {
    minor: { textHash: 'h-1', redetectedTextHash: null },
    poi: { textHash: 'h-1', redetectedTextHash: null },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveRedetection.mockResolvedValue({ ok: true, resolved: 'kept' });
  ruleTextScanFlag.mockResolvedValue({ ok: true, ruled: 'kept', label: 'minor', modelId: 42 });
  confirmMinorFlag.mockResolvedValue({ ok: true });
  revertMinorFlag.mockResolvedValue({ ok: true });
  getFlaggedModels.mockResolvedValue({ items: [], hasMore: false });
  getFlaggedSourceCounts.mockResolvedValue({ all: 3, hash: 2, 'text-scan': 2 });
  getModelAppealState.mockResolvedValue(appealState({ pendingAppeal: false }));
  resolveMinorFlagAppeal.mockResolvedValue({ ok: true, rescanQueued: false });
  resolveMinorFlagAppealPerLabel.mockResolvedValue({ ok: true, rescanQueued: false });
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

describe('held detections', () => {
  it.each(['keepFlag', 'liftFlag'])(
    '%s refuses one: Needs review rules them, under its own permission',
    async (action) => {
      expect(await run(action, { ...redetected, ...kept })).toMatchObject({ status: 400 });
      expect(resolveRedetection).not.toHaveBeenCalled();
    }
  );

  it('decideFlags refuses a row carrying one, before any write', async () => {
    const flags = [
      { label: 'minor', source: 'hash', textHash: null },
      { label: 'poi', source: 'redetected', textHash: 'h-1' },
    ];
    const result = await run('decideFlags', {
      modelId: '42',
      flags: JSON.stringify(flags),
      keep: '',
      ...dismissed,
    });
    expect(result).toMatchObject({ status: 400 });
    expect(revertMinorFlag).not.toHaveBeenCalled();
    expect(resolveRedetection).not.toHaveBeenCalled();
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
  const decide = (
    flags: object[],
    keep: string,
    extra: Record<string, string> = {},
    locals?: object
  ) => run('decideFlags', { modelId: '42', flags: JSON.stringify(flags), keep, ...extra }, locals);

  it('posts the fields the action reads from the decision form', () => {
    const detail = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../../lib/components/minor-flags/FlagDecisionForm.svelte'
      ),
      'utf-8'
    );
    expect(detail).toMatch(/name="modelId"/);
    expect(detail).toMatch(/name="flags" value=\{JSON\.stringify\(flags\)\}/);
    expect(detail).toMatch(/name="keep"/);
    expect(detail).toMatch(/name="hasPendingAppeal" value=\{hasPendingAppeal\}/);
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
    expect(await decide([minorText, poiText], 'minor:text-scan,poi:text-scan', kept)).toMatchObject(
      {
        success: true,
        resolved: 'closed',
      }
    );
    ruleTextScanFlag
      .mockResolvedValueOnce({ ok: true, ruled: 'kept' })
      .mockResolvedValueOnce({ ok: true, ruled: 'closed' });
    expect(await decide([minorText, poiText], 'minor:text-scan,poi:text-scan', kept)).toMatchObject(
      {
        resolved: 'kept',
      }
    );
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
    (await (load as unknown as (e: { url: URL; locals: { user: null } }) => Promise<Loaded>)({
      url: new URL(`http://x/models/flags/auto${query}`),
      locals: { user: null },
    })) as Loaded;

  it('ignores a leftover ?view or ?tab param', async () => {
    await loadQueue('?view=appeals&tab=auto');
    expect(getFlaggedModels).toHaveBeenCalledTimes(1);
  });

  it('takes the total from the active source chip and hands the page every chip count', async () => {
    const loaded = (await loadQueue('?source=hash&flag=minor')) as Loaded & {
      total: number | undefined;
      chipCounts: Record<string, number>;
    };
    expect(getFlaggedSourceCounts).toHaveBeenLastCalledWith({ search: undefined, flag: 'minor' });
    expect(loaded.total).toBe(2);
    expect(loaded.chipCounts).toEqual({ all: 3, hash: 2, 'text-scan': 2 });
  });

  it('still serves the list when the total fails', async () => {
    getFlaggedSourceCounts.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = await loadQueue();
    expect(loaded.items).toEqual([]);
  });

  it('lists every source for the retired re-detect filter (its rows moved to Needs review)', async () => {
    await loadQueue('?source=redetected');
    expect(getFlaggedModels).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { source: 'all', flag: 'all', sort: 'oldest' } })
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

describe('one decision over a row whose model has a pending appeal', () => {
  const minorText = { label: 'minor', source: 'text-scan', textHash: 'h-1' };
  const poiText = { label: 'poi', source: 'text-scan', textHash: 'h-1' };
  const minorHash = { label: 'minor', source: 'hash', textHash: null };
  const decide = (
    flags: object[],
    keep: string,
    extra: Record<string, string> = {},
    locals?: object
  ) =>
    run(
      'decideFlags',
      { modelId: '42', flags: JSON.stringify(flags), keep, hasPendingAppeal: 'true', ...extra },
      locals
    );
  const noPerFlagRuling = () => {
    expect(ruleTextScanFlag).not.toHaveBeenCalled();
    expect(confirmMinorFlag).not.toHaveBeenCalled();
    expect(revertMinorFlag).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    getModelAppealState.mockResolvedValue(appealState());
  });

  it('keeping the flag upholds the appeal instead of ruling the flag', async () => {
    expect(
      await decide([minorHash], 'minor:hash', { resolvedReason: 'flag-confirmed' })
    ).toMatchObject({ success: true, modelId: 42, resolved: 'kept' });
    expect(resolveMinorFlagAppeal).toHaveBeenCalledWith(42, true, {
      resolvedReason: 'flag-confirmed',
      internalNotes: undefined,
    });
    noPerFlagRuling();
  });

  it('reverting the flag overturns the appeal with an approval reason', async () => {
    expect(
      await decide([minorText], '', { resolvedReason: 'not-a-minor', internalNotes: 'adult' })
    ).toMatchObject({ success: true, resolved: 'dismissed' });
    expect(resolveMinorFlagAppeal).toHaveBeenCalledWith(42, false, {
      resolvedReason: 'not-a-minor',
      internalNotes: 'adult',
    });
    noPerFlagRuling();
  });

  it('a split rules the appeal per label', async () => {
    getModelAppealState.mockResolvedValue(appealState({ poi: true }));
    await decide([minorText, poiText], 'minor:text-scan', { resolvedReason: 'not-a-real-person' });
    expect(resolveMinorFlagAppealPerLabel).toHaveBeenCalledWith(
      42,
      { minor: 'uphold', poi: 'overturn' },
      { resolvedReason: 'not-a-real-person', internalNotes: undefined }
    );
    expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
    noPerFlagRuling();
  });

  it('needs an appeal reason: the flag-review reason for a keep is refused', async () => {
    expect(await decide([minorText], 'minor:text-scan', kept)).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/not a reason/) },
    });
    expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
  });

  it('refuses when the model carries a flag the row does not list, before any write', async () => {
    getModelAppealState.mockResolvedValue(appealState({ poi: true }));
    expect(await decide([minorText], '', { resolvedReason: 'not-a-minor' })).toMatchObject({
      status: 400,
      data: { error: expect.stringMatching(/real person/) },
    });
    expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
  });

  it("shows the main app's refusal against the model", async () => {
    resolveMinorFlagAppeal.mockResolvedValue({ ok: false, error: 'No longer flagged.' });
    expect(
      await decide([minorHash], 'minor:hash', { resolvedReason: 'flag-confirmed' })
    ).toMatchObject({
      status: 400,
      data: { error: 'No longer flagged.', modelId: 42, subject: 'Model #42' },
    });
  });

  it('rules each flag as before when no appeal is pending', async () => {
    getModelAppealState.mockResolvedValue(appealState({ pendingAppeal: false }));
    await decide([minorHash], 'minor:hash', { hasPendingAppeal: 'false' });
    expect(confirmMinorFlag).toHaveBeenCalledWith(42);
    expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
  });

  describe('guards that run before the appeal is resolved', () => {
    const reverted = { resolvedReason: 'not-a-minor' };

    it('refuses when the owner filed an appeal after the screen loaded', async () => {
      getModelAppealState.mockResolvedValue(appealState());
      expect(
        await decide([minorHash], 'minor:hash', {
          hasPendingAppeal: 'false',
          resolvedReason: 'other',
          internalNotes: 'x',
        })
      ).toMatchObject({
        status: 400,
        data: { error: expect.stringMatching(/appeal changed since you loaded/) },
      });
      noPerFlagRuling();
      expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
    });

    it('refuses when the appeal was resolved after the screen loaded', async () => {
      getModelAppealState.mockResolvedValue(appealState({ pendingAppeal: false }));
      expect(await decide([minorHash], 'minor:hash', { hasPendingAppeal: 'true' })).toMatchObject({
        status: 400,
        data: { error: expect.stringMatching(/appeal changed since you loaded/) },
      });
      noPerFlagRuling();
    });

    it('refuses a viewer without the Appeals tab, and writes nothing', async () => {
      expect(
        await decide([minorHash], '', reverted, { user: { roles: [] }, grants: {} })
      ).toMatchObject({ status: 400, data: { error: expect.stringMatching(/Appeals tab/) } });
      expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
      noPerFlagRuling();
    });

    it('refuses a text-scan flag whose text changed since the row loaded', async () => {
      getModelAppealState.mockResolvedValue(
        appealState({ textScan: { minor: { textHash: 'h-2', redetectedTextHash: null } } })
      );
      expect(await decide([minorText], '', reverted)).toMatchObject({
        status: 400,
        data: { error: 'The text changed since this flag. Reload and review it again.' },
      });
      expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
    });

    it('refuses a text-scan flag with newer text held for review', async () => {
      getModelAppealState.mockResolvedValue(
        appealState({ textScan: { minor: { textHash: 'h-1', redetectedTextHash: 'h-9' } } })
      );
      expect(
        await decide([minorText], 'minor:text-scan', { resolvedReason: 'flag-confirmed' })
      ).toMatchObject({
        status: 400,
        data: { error: expect.stringMatching(/Newer text is held for review/) },
      });
      expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
    });

    it('does not bind a hash flag to any text', async () => {
      expect(
        await decide([minorHash], 'minor:hash', { resolvedReason: 'flag-confirmed' })
      ).toMatchObject({
        success: true,
      });
    });
  });
});
