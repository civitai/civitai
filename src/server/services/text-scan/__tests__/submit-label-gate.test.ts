import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import type * as ModeModule from '~/server/services/text-scan/mode';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/logging.mock';

// @civitai/orchestration-client is mocked globally in src/__tests__/setup.ts (submitWorkflow is a vi.fn()).
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'active'),
  getTextScanWebSearchMode: vi.fn(async () => 'off'),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
}));

const { scanEntity, textScanCanAskEveryLabel } = await import('~/server/services/text-scan/submit');
const { registerTextScanProfile, resolveTextScanProfileLabels } = await import(
  '~/server/services/text-scan/profiles'
);
const { getTextScanMode, resetTextScanRolloutCache } = await import(
  '~/server/services/text-scan/mode'
);
const { submitWorkflow } = await import('@civitai/orchestration-client');
const { getActiveTextScanPrompts, getTextScanConfig } = await import(
  '~/server/services/text-scan/prompt'
);
const { settleSkippedScan } = await import('~/server/services/text-scan/actions/settle-skipped');
const { getTextScanProfile } = await import('~/server/services/text-scan/profiles');
// The real profiles, so each type's own setting is what is under test; only their loads are faked.
await import('~/server/services/text-scan/profiles/service-deal-review.profile');
await import('~/server/services/text-scan/profiles/service-offering.profile');
await import('~/server/services/text-scan/profiles/article.profile');

const PROMPTS = {
  base: { id: 1, key: 'base', content: 'BASE' },
  'label:scam': { id: 6, key: 'label:scam', content: 'SCAM DEF' },
};
const CSAM_PROMPT = { 'label:csam': { id: 7, key: 'label:csam', content: 'CSAM DEF' } };
const load = async (ids: number[]) =>
  new Map(
    ids.map((id) => [id, { fields: [{ heading: 'Body', text: 'placeholder text' }], declared: {} }])
  );

const em = dbMock.dbWrite.entityModeration;
const lastBody = () =>
  vi.mocked(submitWorkflow).mock.calls.at(-1)![0]!.body! as unknown as {
    metadata: { labels: string[]; promptIds: Record<string, number> };
    steps: { input: { messages: { content: string }[] } }[];
  };
const lastHash = () =>
  (em.upsert.mock.calls.at(-1)![0].create as { contentHash: string }).contentHash;

function csamMode(value: string | undefined) {
  redisMock.sysRedis.hGetAll.mockResolvedValue((value ? { csam: value } : {}) as never);
  resetTextScanRolloutCache();
}

/** The hash a profile without csam submits with: what every row carries before the gate opens. */
async function baselineHash() {
  registerTextScanProfile({ entityType: 'CommentV3', labels: ['scam'], load });
  await scanEntity({ entityType: 'CommentV3', entityId: 3 });
  registerTextScanProfile({ entityType: 'CommentV3', labels: ['scam', 'csam'], load });
  return lastHash();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveTextScanPrompts).mockResolvedValue(PROMPTS);
  vi.mocked(getTextScanConfig).mockResolvedValue({
    model: 'air:test',
    maxInputChars: 1000,
    maxSegments: 10,
    thinking: false,
  });
  em.findUnique.mockResolvedValue(null);
  em.upsert.mockResolvedValue({} as never);
  em.updateMany.mockResolvedValue({ count: 1 });
  vi.mocked(getTextScanMode).mockResolvedValue('active');
  vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-1' } } as never);
  csamMode(undefined);
});

describe('the csam gate at submit time', () => {
  it('drops csam while off: no csam prompt needed and the hash is the pre-gate hash', async () => {
    const before = await baselineHash();
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    expect(lastBody().metadata.labels).toEqual(['scam']);
    expect(lastBody().metadata.promptIds).toEqual({ base: 1, scam: 6 });
    expect(lastHash()).toBe(before);
  });

  it('treats an unparseable gate as off', async () => {
    const before = await baselineHash();
    csamMode('auto');
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toMatchObject({
      status: 'submitted',
    });
    expect(lastBody().metadata.labels).toEqual(['scam']);
    expect(lastHash()).toBe(before);
  });

  it('treats an unreadable gate as off', async () => {
    const before = await baselineHash();
    redisMock.sysRedis.hGetAll.mockRejectedValue(new Error('down'));
    resetTextScanRolloutCache();
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toMatchObject({
      status: 'submitted',
    });
    expect(lastBody().metadata.labels).toEqual(['scam']);
    expect(lastHash()).toBe(before);
  });

  it('skips a row already scanned before the gate existed while csam stays off', async () => {
    const before = await baselineHash();
    em.findUnique.mockResolvedValue({
      status: 'Succeeded',
      contentHash: before,
      workflowId: 'wf-old',
      retryCount: 0,
      updatedAt: new Date(),
    } as never);
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toEqual({
      status: 'skipped',
      reason: 'unchanged',
    });
  });

  it('asks for csam in review, with a new hash, so that row is rescanned once', async () => {
    const before = await baselineHash();
    em.findUnique.mockResolvedValue({
      status: 'Succeeded',
      contentHash: before,
      workflowId: 'wf-old',
      retryCount: 0,
      updatedAt: new Date(),
    } as never);
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue({ ...PROMPTS, ...CSAM_PROMPT });
    csamMode('review');
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    expect(lastBody().metadata.labels).toEqual(['scam', 'csam']);
    expect(lastBody().steps[0].input.messages[0].content).toContain('CSAM DEF');
    expect(lastHash()).not.toBe(before);
  });
});

describe('csam in review without an active csam prompt', () => {
  it('skips a csam-only profile as off', async () => {
    csamMode('review');
    registerTextScanProfile({ entityType: 'CommentV3', labels: ['csam'], load });
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toEqual({
      status: 'skipped',
      reason: 'off',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('still submits the other labels, with the hash they had before csam', async () => {
    const before = await baselineHash();
    csamMode('review');
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    expect(lastBody().metadata.labels).toEqual(['scam']);
    expect(lastBody().metadata.promptIds).toEqual({ base: 1, scam: 6 });
    expect(lastHash()).toBe(before);
  });
});

describe('csam in a shadow scan', () => {
  beforeEach(() => {
    vi.mocked(getTextScanMode).mockResolvedValue('shadow');
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue({ ...PROMPTS, ...CSAM_PROMPT });
    csamMode('review');
  });

  it('is never asked for, since nothing would hold its verdict', async () => {
    registerTextScanProfile({ entityType: 'CommentV3', labels: ['scam', 'csam'], load });
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toMatchObject({
      status: 'submitted',
    });
    expect(lastBody().metadata.labels).toEqual(['scam']);
  });

  it('skips a csam-only profile as off', async () => {
    registerTextScanProfile({ entityType: 'CommentV3', labels: ['csam'], load });
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toEqual({
      status: 'skipped',
      reason: 'off',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });
});

describe('a profile that narrows its labels per subject', () => {
  const narrowTo = (labels: ('scam' | 'csam')[]) =>
    registerTextScanProfile({
      entityType: 'CommentV3',
      labels: ['scam', 'csam'],
      load,
      labelsFor: () => labels,
    });

  it('asks only for the gated labels the subject keeps', async () => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue({ ...PROMPTS, ...CSAM_PROMPT });
    csamMode('review');
    narrowTo(['csam']);
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toMatchObject({
      status: 'submitted',
    });
    expect(lastBody().metadata.labels).toEqual(['csam']);
    expect(lastBody().metadata.promptIds).toEqual({ base: 1, csam: 7 });
  });

  it('submits nothing when the gate drops every label the subject keeps', async () => {
    narrowTo(['csam']);
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toEqual({
      status: 'skipped',
      reason: 'off',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });
});

describe('the gate is read before the subject is loaded', () => {
  it('skips as off without loading when the gate drops every label', async () => {
    const csamOnlyLoad = vi.fn(load);
    registerTextScanProfile({ entityType: 'CommentV3', labels: ['csam'], load: csamOnlyLoad });
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toEqual({
      status: 'skipped',
      reason: 'off',
    });
    expect(csamOnlyLoad).not.toHaveBeenCalled();
  });

  it('reports a missing entity once a label survives the gate', async () => {
    csamMode('review');
    registerTextScanProfile({
      entityType: 'CommentV3',
      labels: ['csam'],
      load: async () => new Map(),
    });
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toEqual({
      status: 'skipped',
      reason: 'missing',
    });
  });

  it('clears every profile label when a narrowed subject is too short', async () => {
    csamMode('review');
    registerTextScanProfile({
      entityType: 'CommentV3',
      labels: ['scam', 'csam'],
      minChars: 50,
      load,
      labelsFor: () => ['csam'],
    });
    em.findUnique.mockResolvedValue({
      workflowId: 'wf-old',
      status: 'Succeeded',
      nsfwLevel: null,
      triggeredLabels: ['scam'],
      result: { version: 1 },
    } as never);
    expect(await scanEntity({ entityType: 'CommentV3', entityId: 3 })).toEqual({
      status: 'skipped',
      reason: 'too-short',
    });
    const { data } = em.updateMany.mock.calls[0][0] as {
      data: { triggeredLabels: string[]; result: { labels: Record<string, unknown> } };
    };
    expect(data.triggeredLabels).toEqual([]);
    expect(Object.keys(data.result.labels).sort()).toEqual(['csam', 'scam']);
  });
});

describe('resolveTextScanProfileLabels', () => {
  const subject = { fields: [{ heading: 'Body', text: 'placeholder text' }], declared: {} };

  it.each(['off', 'review'])('%s: a subject changes nothing without labelsFor', async (mode) => {
    csamMode(mode);
    const profile = { labels: ['scam', 'csam'] as ('scam' | 'csam')[] };
    expect(await resolveTextScanProfileLabels(profile, subject)).toEqual(
      await resolveTextScanProfileLabels(profile)
    );
    expect(await resolveTextScanProfileLabels(profile, subject)).toEqual(
      mode === 'review' ? ['scam', 'csam'] : ['scam']
    );
  });
});

describe('a scan settles only on a verdict that answers every label its profile requires', () => {
  const REQUIRING = ['ServiceDealReview', 'ServiceDealReviewReply'] as const;
  const NOT_REQUIRING = ['ServiceOffering', 'Article'] as const;

  const reviewLoad = async (ids: number[]) =>
    new Map(
      ids.map((id) => [
        id,
        { fields: [{ heading: 'Body', text: 'placeholder text' }], declared: { nsfwLevel: 1 } },
      ])
    );
  beforeAll(() => {
    for (const type of [...REQUIRING, ...NOT_REQUIRING])
      registerTextScanProfile({ ...getTextScanProfile(type)!, load: reviewLoad });
  });

  const EVERY_PROMPT = {
    base: { id: 1, key: 'base', content: 'BASE' },
    'label:nsfw': { id: 2, key: 'label:nsfw', content: 'NSFW DEF' },
    'label:csam': { id: 3, key: 'label:csam', content: 'CSAM DEF' },
  };

  // The first submit is the scan; a profile with a category hook submits its category call after it.
  const scanLabels = () =>
    (
      vi.mocked(submitWorkflow).mock.calls[0][0]!.body! as unknown as {
        metadata: { labels: string[] };
      }
    ).metadata.labels;

  function gate(value: string | undefined) {
    redisMock.sysRedis.hGetAll.mockResolvedValue((value ? { csam: value } : {}) as never);
    resetTextScanRolloutCache();
  }

  /** Cases where a required label is not asked. */
  const CAUSES: [string, () => void][] = [
    ['case 1', () => gate(undefined)],
    [
      'case 2',
      () => {
        redisMock.sysRedis.hGetAll.mockRejectedValue(new Error('down'));
        resetTextScanRolloutCache();
      },
    ],
    [
      'case 3',
      () =>
        vi.mocked(getActiveTextScanPrompts).mockResolvedValue({
          ...EVERY_PROMPT,
          'label:csam': { id: 3, key: 'label:csam', content: '  ' },
        }),
    ],
  ];

  beforeEach(() => {
    vi.mocked(getActiveTextScanPrompts).mockResolvedValue(EVERY_PROMPT);
    gate('review');
  });

  describe('a profile that requires every label (civitai/civitai#10118)', () => {
    it.each(REQUIRING)('%s submits with every label when all can be asked', async (entityType) => {
      expect(await scanEntity({ entityType, entityId: 1 })).toEqual({
        status: 'submitted',
        workflowId: 'wf-1',
      });
      expect(scanLabels()).toEqual(['nsfw', 'csam']);
    });

    describe.each(REQUIRING)('%s', (entityType) => {
      it.each(CAUSES)('records and submits nothing for %s', async (_, cause) => {
        cause();
        expect(await scanEntity({ entityType, entityId: 1 })).toEqual({
          status: 'skipped',
          reason: 'incomplete',
        });
        expect(submitWorkflow).not.toHaveBeenCalled();
        // No Pending row: nothing waits on a check that was never sent.
        expect(em.upsert).not.toHaveBeenCalled();
      });

      it('still submits in shadow, whose verdict settles nothing', async () => {
        vi.mocked(getTextScanMode).mockResolvedValue('shadow');
        expect(await scanEntity({ entityType, entityId: 1 })).toMatchObject({
          status: 'submitted',
        });
      });
    });
  });

  /**
   * Control: only a profile that opts in changes. If this fails, the requirement has spread to a type
   * that did not ask for it; that is a behavior change for that type, not a fix.
   */
  describe.each(NOT_REQUIRING)('%s, which does not require every label', (entityType) => {
    it.each(CAUSES)('submits what it can ask for %s, as before', async (_, cause) => {
      cause();
      expect(await scanEntity({ entityType, entityId: 1 })).toEqual({
        status: 'submitted',
        workflowId: 'wf-1',
      });
      expect(scanLabels()).toEqual(['nsfw']);
    });

    it('never reads the prompts to say it can ask, so an unreadable read cannot refuse it', async () => {
      csamMode('review');
      vi.mocked(getActiveTextScanPrompts).mockRejectedValue(new Error('prompts unreadable'));
      await expect(textScanCanAskEveryLabel(getTextScanProfile(entityType)!)).resolves.toBe(true);
    });
  });

  describe('whether a profile that requires every label can ask them all', () => {
    const unreadable = () =>
      vi.mocked(getActiveTextScanPrompts).mockRejectedValue(new Error('prompts unreadable'));

    it('does not depend on the prompts when it never asks for csam', async () => {
      unreadable();
      await expect(
        textScanCanAskEveryLabel({ labels: ['nsfw', 'scam'], requireEveryLabel: true })
      ).resolves.toBe(true);
    });

    it('cannot be answered when it asks for csam and the prompts are unreadable', async () => {
      csamMode('review');
      unreadable();
      await expect(
        textScanCanAskEveryLabel({ labels: ['nsfw', 'csam'], requireEveryLabel: true })
      ).rejects.toThrow('prompts unreadable');
    });
  });

  describe('a profile that does not require every label', () => {
    it('settles on a stored verdict that answers only some labels', async () => {
      em.findUnique.mockResolvedValue({
        status: 'Succeeded',
        nsfwLevel: 1,
        result: { version: 1, labels: { nsfw: { level: 'none', reason: '' } } },
      } as never);
      const apply = vi.fn(async () => undefined);
      await settleSkippedScan(
        'ServiceOffering',
        1,
        'unchanged',
        apply,
        {},
        getTextScanProfile('ServiceOffering')
      );
      expect(apply).toHaveBeenCalledWith(1, { stored: true });
    });
  });

  describe('a stored verdict for a profile that requires every label', () => {
    const stored = (labels: Record<string, unknown>) =>
      em.findUnique.mockResolvedValue({
        status: 'Succeeded',
        nsfwLevel: 1,
        result: { version: 1, labels },
      } as never);
    const nsfw = { level: 'none', reason: '' };
    const csam = { detected: false, reason: '' };

    it.each(REQUIRING)('%s settles on one that answers every label', async (entityType) => {
      stored({ nsfw, csam });
      const apply = vi.fn(async () => undefined);
      await settleSkippedScan(
        entityType,
        1,
        'unchanged',
        apply,
        {},
        getTextScanProfile(entityType)
      );
      expect(apply).toHaveBeenCalledWith(1, { stored: true });
    });

    it.each(REQUIRING)('%s does not settle on one that misses a label', async (entityType) => {
      stored({ nsfw });
      const apply = vi.fn(async () => undefined);
      await settleSkippedScan(
        entityType,
        1,
        'unchanged',
        apply,
        {},
        getTextScanProfile(entityType)
      );
      expect(apply).not.toHaveBeenCalled();
    });
  });
});
