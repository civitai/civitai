import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  bustFetchThroughCache: vi.fn(),
}));

const {
  composeTextScanMessages,
  subjectTextLength,
  getTextScanConfig,
  setTextScanConfig,
  setTextScanRollout,
  setTextScanWebSearchRollout,
  setTextScanLabelMode,
  setTextScanCsamMode,
  insertTextScanPrompt,
  MissingTextScanPromptError,
  DEFAULT_TEXT_SCAN_MODEL,
  textScanTextHash,
} = await import('~/server/services/text-scan/prompt');
const { bustFetchThroughCache } = await import('~/server/utils/cache-helpers');
const { TEXT_SCAN_LABELS } = await import('~/server/services/text-scan/types');
const { composeUserText } = await import('~/server/services/text-scan/segment');
const { hashContent } = await import('~/server/services/entity-moderation.service');

const prompts = {
  base: { id: 10, key: 'base', content: 'BASE PROMPT' },
  'label:nsfw': { id: 11, key: 'label:nsfw', content: 'NSFW DEF' },
  'label:poi': { id: 12, key: 'label:poi', content: 'POI DEF' },
};

const subject = {
  fields: [
    { heading: 'Name', text: 'My LoRA' },
    { heading: 'Description', text: '' },
    { heading: 'Trained words', text: null },
    { heading: 'Version', text: 'v1 notes' },
  ],
  declared: {},
};

const DEFAULTS = {
  model: DEFAULT_TEXT_SCAN_MODEL,
  maxInputChars: 200000,
  maxSegments: 10,
  thinking: false,
};

describe('composeTextScanMessages', () => {
  it('puts base then each requested label definition in the system message', () => {
    const { system, promptIds } = composeTextScanMessages({
      prompts,
      labels: ['nsfw', 'poi'],
      subject,
      maxInputChars: 1000,
      maxSegments: 10,
    });
    expect(system.indexOf('BASE PROMPT')).toBeLessThan(system.indexOf('NSFW DEF'));
    expect(system.indexOf('NSFW DEF')).toBeLessThan(system.indexOf('POI DEF'));
    expect(promptIds).toEqual({ base: 10, nsfw: 11, poi: 12 });
  });

  it('omits definitions for labels the profile does not request', () => {
    const { system, promptIds } = composeTextScanMessages({
      prompts,
      labels: ['nsfw'],
      subject,
      maxInputChars: 1000,
      maxSegments: 10,
    });
    expect(system).not.toContain('POI DEF');
    expect(promptIds).toEqual({ base: 10, nsfw: 11 });
  });

  it('throws naming every missing key', () => {
    expect(() =>
      composeTextScanMessages({
        prompts: { base: prompts.base },
        labels: ['nsfw', 'scam'],
        subject,
        maxInputChars: 1000,
        maxSegments: 10,
      })
    ).toThrow(MissingTextScanPromptError);
    try {
      composeTextScanMessages({
        prompts: {},
        labels: ['scam'],
        subject,
        maxInputChars: 1000,
        maxSegments: 10,
      });
    } catch (e) {
      expect((e as InstanceType<typeof MissingTextScanPromptError>).keys).toEqual([
        'base',
        'label:scam',
      ]);
    }
  });

  it('treats a whitespace-only prompt row as missing', () => {
    const compose = () =>
      composeTextScanMessages({
        prompts: { ...prompts, 'label:nsfw': { id: 11, key: 'label:nsfw', content: ' \n ' } },
        labels: ['nsfw'],
        subject,
        maxInputChars: 1000,
        maxSegments: 10,
      });
    expect(compose).toThrow(MissingTextScanPromptError);
    expect(compose).toThrow('label:nsfw');
  });
});

describe('composeTextScanMessages segments', () => {
  const body = (n: number) => ({ fields: [{ heading: 'B', text: 'x'.repeat(n) }], declared: {} });
  const labels = ['scam'] as any;
  const p = { base: { id: 1, content: 'b' }, 'label:scam': { id: 2, content: 's' } } as any;

  it('sends text within the budget whole, as one segment equal to the full text', () => {
    const fits = composeTextScanMessages({
      prompts: p,
      labels,
      subject: body(100),
      maxInputChars: 200000,
      maxSegments: 10,
    });
    expect(fits.segments).toEqual([fits.text]);
    expect(fits).toMatchObject({ inputChars: '## B\n'.length + 100, inputCut: false });
  });

  it('splits text past the budget instead of cutting it', () => {
    const big = composeTextScanMessages({
      prompts: p,
      labels,
      subject: body(250000),
      maxInputChars: 200000,
      maxSegments: 10,
    });
    expect(big.segments).toHaveLength(2);
    expect(big.segments.every((s) => s.length <= 200000)).toBe(true);
    expect(big).toMatchObject({ inputChars: '## B\n'.length + 250000, inputCut: false });
  });

  it('reports a cut only when maxSegments runs out', () => {
    const cut = composeTextScanMessages({
      prompts: p,
      labels,
      subject: body(250000),
      maxInputChars: 200000,
      maxSegments: 1,
    });
    expect(cut.segments).toHaveLength(1);
    expect(cut.scannedChars).toBeLessThan(cut.inputChars);
    expect(cut.inputCut).toBe(true);
  });
});

describe('subjectTextLength', () => {
  it('counts trimmed field text only, never the headings', () => {
    const short = {
      fields: [
        { heading: 'Message window', text: '  hi ' },
        { heading: 'X', text: null },
      ],
      declared: {},
    };
    expect(subjectTextLength(short)).toBe(2);
    expect(composeUserText(short).length).toBeGreaterThan(10);
    expect(subjectTextLength(subject)).toBe('My LoRA'.length + 'v1 notes'.length);
  });
});

describe('getTextScanConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('falls back to defaults when the key is absent', async () => {
    redisMock.sysRedis.get.mockResolvedValue(null);
    expect(await getTextScanConfig()).toEqual(DEFAULTS);
  });

  it('reads through the sysRedis read deadline', async () => {
    redisMock.sysRedis.get.mockResolvedValue(null);
    await getTextScanConfig();
    expect(redisMock.withSysReadDeadline).toHaveBeenCalled();
  });

  it('merges a partial override', async () => {
    redisMock.sysRedis.get.mockResolvedValue(
      JSON.stringify({ maxInputChars: 5000, thinking: true })
    );
    expect(await getTextScanConfig()).toEqual({ ...DEFAULTS, maxInputChars: 5000, thinking: true });
  });

  it('falls back to defaults on unparseable or invalid config', async () => {
    redisMock.sysRedis.get.mockResolvedValue('{not json');
    expect((await getTextScanConfig()).maxInputChars).toBe(200000);
    redisMock.sysRedis.get.mockResolvedValue(
      JSON.stringify({ maxInputChars: -1, model: '', thinking: 'yes' })
    );
    expect(await getTextScanConfig()).toEqual(DEFAULTS);
  });

  it('reads maxSegments and ignores one outside 1-20', async () => {
    redisMock.sysRedis.get.mockResolvedValue(JSON.stringify({ maxSegments: 3 }));
    expect((await getTextScanConfig()).maxSegments).toBe(3);
    for (const bad of [0, 21, 2.5, '4'])
      redisMock.sysRedis.get.mockResolvedValueOnce(JSON.stringify({ maxSegments: bad }));
    for (let i = 0; i < 4; i++) expect((await getTextScanConfig()).maxSegments).toBe(10);
  });

  it('falls back to defaults when sysRedis throws', async () => {
    redisMock.sysRedis.get.mockRejectedValueOnce(new Error('down'));
    expect(await getTextScanConfig()).toEqual(DEFAULTS);
  });

  it('falls back to defaults when the read deadline fires', async () => {
    redisMock.sysRedis.get.mockResolvedValue(null);
    redisMock.withSysReadDeadline.mockImplementationOnce(async () => {
      throw new Error('sysRedis read timed out after 1ms');
    });
    expect(await getTextScanConfig()).toEqual(DEFAULTS);
  });
});

describe('setTextScanConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a user who is not an active moderator', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue(null);
    await expect(setTextScanConfig({ thinking: true }, { moderatorId: 9 })).rejects.toThrow();
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });

  it('merges the patch over the current config, writes the whole object and logs who', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    redisMock.sysRedis.get.mockResolvedValue(JSON.stringify({ maxInputChars: 5000 }));
    const next = await setTextScanConfig({ thinking: true }, { moderatorId: 5 });
    expect(next).toEqual({ ...DEFAULTS, maxInputChars: 5000, thinking: true });
    expect(redisMock.sysRedis.set).toHaveBeenCalledWith(
      'system:text-scan:config',
      JSON.stringify(next)
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'text-scan', moderatorId: 5, config: next })
    );
  });

  it('throws instead of writing defaults over a config it could not read', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    redisMock.sysRedis.get.mockRejectedValueOnce(new Error('down'));
    await expect(setTextScanConfig({ thinking: true }, { moderatorId: 5 })).rejects.toThrow('down');
    redisMock.sysRedis.get.mockResolvedValueOnce('{not json');
    await expect(setTextScanConfig({ thinking: true }, { moderatorId: 5 })).rejects.toThrow();
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });
});

describe('setTextScanRollout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses a user who is not an active moderator', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue(null);
    await expect(
      setTextScanRollout('Model', { shadow: 100, active: 0 }, { moderatorId: 9 })
    ).rejects.toThrow();
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
  });

  it('refuses an active share unless allowActive is set', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    await expect(
      setTextScanRollout('Model', { shadow: 100, active: 1 }, { moderatorId: 5 })
    ).rejects.toThrow('allowActive');
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    await setTextScanRollout(
      'Model',
      { shadow: 100, active: 1 },
      { moderatorId: 5, allowActive: true }
    );
    expect(redisMock.sysRedis.hSet).toHaveBeenCalledWith(
      'system:text-scan:modes',
      'Model',
      '{"shadow":100,"active":1}'
    );
  });

  it('writes a shadow rollout, logs who, and removes the field for null', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    await setTextScanRollout('Comment', { shadow: 100, active: 0 }, { moderatorId: 5 });
    expect(redisMock.sysRedis.hSet).toHaveBeenCalledWith(
      'system:text-scan:modes',
      'Comment',
      '{"shadow":100,"active":0}'
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'rollout updated', moderatorId: 5, entityType: 'Comment' })
    );
    await setTextScanRollout('Comment', null, { moderatorId: 5 });
    expect(redisMock.sysRedis.hDel).toHaveBeenCalledWith('system:text-scan:modes', 'Comment');
  });
});

describe('setTextScanWebSearchRollout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses entity types other than Model and users who are not active moderators', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    await expect(
      setTextScanWebSearchRollout('Post', { shadow: 10, active: 0 }, { moderatorId: 5 })
    ).rejects.toThrow('Model');
    dbMock.dbRead.user.findFirst.mockResolvedValue(null);
    await expect(
      setTextScanWebSearchRollout('Model', { shadow: 10, active: 0 }, { moderatorId: 9 })
    ).rejects.toThrow();
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
  });

  it('refuses an active share unless allowActive is set', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    await expect(
      setTextScanWebSearchRollout('Model', { shadow: 100, active: 10 }, { moderatorId: 5 })
    ).rejects.toThrow('allowActive');
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    await setTextScanWebSearchRollout(
      'Model',
      { shadow: 100, active: 10 },
      { moderatorId: 5, allowActive: true }
    );
    expect(redisMock.sysRedis.hSet).toHaveBeenCalledWith(
      'system:text-scan:web-search',
      'Model',
      '{"shadow":100,"active":10}'
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'web-search rollout updated', moderatorId: 5 })
    );
  });

  it('removes the field for null', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    await setTextScanWebSearchRollout('Model', null, { moderatorId: 5 });
    expect(redisMock.sysRedis.hDel).toHaveBeenCalledWith('system:text-scan:web-search', 'Model');
  });
});

describe('setTextScanLabelMode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses users who are not active moderators, and unknown labels', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue(null);
    await expect(setTextScanLabelMode('minor', 'review', { moderatorId: 9 })).rejects.toThrow();
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    await expect(
      setTextScanLabelMode('nsfw' as never, 'review', { moderatorId: 5 })
    ).rejects.toThrow('nsfw');
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
  });

  it('writes review, removes the field for auto, and logs both', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    await setTextScanLabelMode('minor', 'review', { moderatorId: 5 });
    expect(redisMock.sysRedis.hSet).toHaveBeenCalledWith(
      'system:text-scan:label-modes',
      'minor',
      'review'
    );
    await setTextScanLabelMode('minor', 'auto', { moderatorId: 5 });
    expect(redisMock.sysRedis.hDel).toHaveBeenCalledWith('system:text-scan:label-modes', 'minor');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'label mode updated',
        moderatorId: 5,
        label: 'minor',
        mode: 'review',
      })
    );
  });
});

describe('setTextScanCsamMode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses users who are not active moderators, and any mode but off or review', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { id: 7, key: 'label:csam', content: 'CSAM DEF' },
    ] as never);
    await expect(setTextScanCsamMode('review', { moderatorId: 9 })).rejects.toThrow(
      'not an active moderator'
    );
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    await expect(setTextScanCsamMode('auto' as never, { moderatorId: 5 })).rejects.toThrow(
      'csam has no auto mode'
    );
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.hDel).not.toHaveBeenCalled();
  });

  it.each([
    ['no csam prompt row', []],
    ['a blank csam prompt row', [{ id: 7, key: 'label:csam', content: '  ' }]],
  ])('refuses review while there is %s, and still allows off', async (_, rows) => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    dbMock.dbWrite.$queryRaw.mockResolvedValue(rows as never);
    await expect(setTextScanCsamMode('review', { moderatorId: 5 })).rejects.toThrow('label:csam');
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    redisMock.sysRedis.hGetAll.mockResolvedValue({} as never);
    expect(await setTextScanCsamMode('off', { moderatorId: 5 })).toBe('off');
  });

  it('writes review, removes the field for off, logs both, and this pod sees it at once', async () => {
    const { getTextScanCsamMode, resetTextScanRolloutCache } = await import(
      '~/server/services/text-scan/mode'
    );
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { id: 7, key: 'label:csam', content: 'CSAM DEF' },
    ] as never);
    resetTextScanRolloutCache();
    redisMock.sysRedis.hGetAll.mockResolvedValue({} as never);
    expect(await getTextScanCsamMode()).toBe('off');

    redisMock.sysRedis.hGetAll.mockResolvedValue({ csam: 'review' } as never);
    expect(await setTextScanCsamMode('review', { moderatorId: 5 })).toBe('review');
    expect(redisMock.sysRedis.hSet).toHaveBeenCalledWith(
      'system:text-scan:label-modes',
      'csam',
      'review'
    );
    expect(await getTextScanCsamMode()).toBe('review');

    redisMock.sysRedis.hGetAll.mockResolvedValue({} as never);
    expect(await setTextScanCsamMode('off', { moderatorId: 5 })).toBe('off');
    expect(redisMock.sysRedis.hDel).toHaveBeenCalledWith('system:text-scan:label-modes', 'csam');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'label mode updated', label: 'csam', mode: 'review' })
    );
    resetTextScanRolloutCache();
  });
});

describe('setTextScanLabelMode cache', () => {
  it('drops the cached read, so this pod sees the change at once', async () => {
    const { getTextScanLabelMode, resetTextScanRolloutCache } = await import(
      '~/server/services/text-scan/mode'
    );
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    resetTextScanRolloutCache();
    redisMock.sysRedis.hGetAll.mockResolvedValue({} as never);
    expect(await getTextScanLabelMode('minor')).toBe('auto');

    redisMock.sysRedis.hGetAll.mockResolvedValue({ minor: 'review' } as never);
    expect(await getTextScanLabelMode('minor')).toBe('auto');
    await setTextScanLabelMode('minor', 'review', { moderatorId: 5 });

    expect(await getTextScanLabelMode('minor')).toBe('review');
    resetTextScanRolloutCache();
  });
});

describe('textScanTextHash', () => {
  it('hashes the uncapped composed text only', () => {
    const long = { fields: [{ heading: 'Body', text: 'x'.repeat(20000) }], declared: {} };
    const longer = { fields: [{ heading: 'Body', text: 'x'.repeat(20001) }], declared: {} };
    expect(textScanTextHash(long)).toMatch(/^[0-9a-f]{64}$/);
    expect(textScanTextHash(long)).not.toBe(textScanTextHash(longer));
    expect(textScanTextHash({ ...subject, declared: { nsfwLevel: 8 } })).toBe(
      textScanTextHash(subject)
    );
  });

  it('hashes exactly the #5856 composition', () => {
    expect(textScanTextHash(subject)).toBe(hashContent('## Name\nMy LoRA\n\n## Version\nv1 notes'));
    expect(composeUserText(subject)).toBe('## Name\nMy LoRA\n\n## Version\nv1 notes');
  });
});

describe('insertTextScanPrompt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an unknown key', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    await expect(
      insertTextScanPrompt({ key: 'label:hate', content: 'x', createdById: 5 })
    ).rejects.toThrow();
    expect(dbMock.dbWrite.textScanPrompt.create).not.toHaveBeenCalled();
  });

  it.each(TEXT_SCAN_LABELS)('accepts a prompt for the %s label', async (label) => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    dbMock.dbWrite.textScanPrompt.create.mockResolvedValue({ id: 3, key: `label:${label}` });
    await insertTextScanPrompt({ key: `label:${label}`, content: 'x', createdById: 5 });
    expect(dbMock.dbWrite.textScanPrompt.create).toHaveBeenCalled();
  });

  it('rejects a createdById that is not an active moderator', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue(null);
    await expect(
      insertTextScanPrompt({ key: 'base', content: 'x', createdById: 9 })
    ).rejects.toThrow();
    expect(dbMock.dbRead.user.findFirst).toHaveBeenCalledWith({
      where: { id: 9, isModerator: true, deletedAt: null, bannedAt: null },
      select: { id: true },
    });
    expect(dbMock.dbWrite.textScanPrompt.create).not.toHaveBeenCalled();
  });

  it('inserts and busts the cache', async () => {
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
    dbMock.dbWrite.textScanPrompt.create.mockResolvedValue({ id: 3, key: 'base' });
    await insertTextScanPrompt({
      key: 'base',
      content: 'BASE PROMPT',
      note: 'why',
      createdById: 5,
    });
    expect(dbMock.dbWrite.textScanPrompt.create).toHaveBeenCalledWith({
      data: { key: 'base', content: 'BASE PROMPT', note: 'why', createdById: 5 },
      select: { id: true, key: true },
    });
    expect(bustFetchThroughCache).toHaveBeenCalled();
  });
});

describe('insertTextScanPrompt with a base version', () => {
  const save = (baseId: number | null) =>
    insertTextScanPrompt({ key: 'base', content: 'B', createdById: 5, baseId });

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.user.findFirst.mockResolvedValue({ id: 5 });
  });

  it('takes the per-key lock, reads the newest version, then inserts', async () => {
    const order: string[] = [];
    dbMock.dbWrite.$queryRaw.mockImplementationOnce(async () => {
      order.push('lock');
      return [{ locked: 1 }];
    });
    dbMock.dbWrite.textScanPrompt.findFirst.mockImplementationOnce(async () => {
      order.push('read');
      return { id: 3 };
    });
    dbMock.dbWrite.textScanPrompt.create.mockImplementationOnce(async () => {
      order.push('insert');
      return { id: 4, key: 'base' };
    });
    await expect(save(3)).resolves.toEqual({ id: 4, key: 'base' });
    expect(order).toEqual(['lock', 'read', 'insert']);
    expect(dbMock.dbWrite.textScanPrompt.findFirst).toHaveBeenCalledWith({
      where: { key: 'base' },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    expect(bustFetchThroughCache).toHaveBeenCalled();
  });

  it('refuses with CONFLICT when a newer version exists, and inserts nothing', async () => {
    dbMock.dbWrite.textScanPrompt.findFirst.mockResolvedValueOnce({ id: 4 });
    await expect(save(3)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(dbMock.dbWrite.textScanPrompt.create).not.toHaveBeenCalled();
    expect(bustFetchThroughCache).not.toHaveBeenCalled();
  });

  it('reads a null base as "no version yet"', async () => {
    dbMock.dbWrite.textScanPrompt.findFirst.mockResolvedValueOnce(null);
    dbMock.dbWrite.textScanPrompt.create.mockResolvedValueOnce({ id: 1, key: 'base' });
    await expect(save(null)).resolves.toEqual({ id: 1, key: 'base' });
    dbMock.dbWrite.textScanPrompt.findFirst.mockResolvedValueOnce({ id: 1 });
    await expect(save(null)).rejects.toMatchObject({ code: 'CONFLICT' });
    dbMock.dbWrite.textScanPrompt.findFirst.mockResolvedValueOnce(null);
    await expect(save(3)).rejects.toThrow(/^(?!.*undefined)/);
  });

  it('lets only one of two saves from the same base through', async () => {
    const ids = [3];
    let held: Promise<void> | null = null;
    let release = () => undefined;
    const tx = async (fn: unknown) => {
      try {
        return await (fn as (client: unknown) => Promise<unknown>)(dbMock.dbWrite);
      } finally {
        const done = release;
        held = null;
        done();
      }
    };
    const lock = async () => {
      while (held) await held;
      held = new Promise<void>((resolve) => (release = resolve));
      return [{ locked: 1 }];
    };
    dbMock.dbWrite.$transaction.mockImplementationOnce(tx).mockImplementationOnce(tx);
    dbMock.dbWrite.$queryRaw.mockImplementationOnce(lock).mockImplementationOnce(lock);
    dbMock.dbWrite.textScanPrompt.findFirst.mockImplementation(async () => ({
      id: Math.max(...ids),
    }));
    dbMock.dbWrite.textScanPrompt.create.mockImplementation(async () => {
      const id = Math.max(...ids) + 1;
      ids.push(id);
      return { id, key: 'base' };
    });

    const results = await Promise.allSettled([save(3), save(3)]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(ids).toEqual([3, 4]);
  });
});
