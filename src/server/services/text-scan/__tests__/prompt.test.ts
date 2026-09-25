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
  composeUserMessage,
  subjectTextLength,
  getTextScanConfig,
  setTextScanConfig,
  insertTextScanPrompt,
  MissingTextScanPromptError,
  DEFAULT_TEXT_SCAN_MODEL,
  textScanTextHash,
} = await import('~/server/services/text-scan/prompt');
const { bustFetchThroughCache } = await import('~/server/utils/cache-helpers');

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

const DEFAULTS = { model: DEFAULT_TEXT_SCAN_MODEL, maxInputChars: 12000, thinking: false };

describe('composeTextScanMessages', () => {
  it('puts base then each requested label definition in the system message', () => {
    const { system, promptIds } = composeTextScanMessages({
      prompts,
      labels: ['nsfw', 'poi'],
      subject,
      maxInputChars: 1000,
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
      })
    ).toThrow(MissingTextScanPromptError);
    try {
      composeTextScanMessages({ prompts: {}, labels: ['scam'], subject, maxInputChars: 1000 });
    } catch (e) {
      expect((e as InstanceType<typeof MissingTextScanPromptError>).keys).toEqual([
        'base',
        'label:scam',
      ]);
    }
  });
});

describe('composeUserMessage', () => {
  it('renders non-empty fields under plain headers, skipping empty ones', () => {
    expect(composeUserMessage(subject, 1000)).toBe('## Name\nMy LoRA\n\n## Version\nv1 notes');
  });

  it('caps at maxInputChars', () => {
    const long = { fields: [{ heading: 'Body', text: 'x'.repeat(500) }], declared: {} };
    expect(composeUserMessage(long, 100)).toHaveLength(100);
  });

  it('returns an empty string when every field is empty', () => {
    expect(composeUserMessage({ fields: [{ heading: 'A', text: '  ' }], declared: {} }, 100)).toBe(
      ''
    );
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
    expect(composeUserMessage(short, 1000).length).toBeGreaterThan(10);
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
    expect((await getTextScanConfig()).maxInputChars).toBe(12000);
    redisMock.sysRedis.get.mockResolvedValue(
      JSON.stringify({ maxInputChars: -1, model: '', thinking: 'yes' })
    );
    expect(await getTextScanConfig()).toEqual(DEFAULTS);
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
