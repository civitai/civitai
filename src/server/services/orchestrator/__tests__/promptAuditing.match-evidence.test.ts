import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserRestrictionService from '~/server/services/user-restriction.service';

const { mockClickhouseQuery } = vi.hoisted(() => ({ mockClickhouseQuery: vi.fn() }));

vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: vi.fn(async () => ({ flagged: false, categories: [] })) },
}));
vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: vi.fn(async (text?: string) => text),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: mockClickhouseQuery } }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateUserById: vi.fn() }));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/user-restriction.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserRestrictionService>()),
  applyPendingReviewMute: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/prompt-origin', () => ({
  attachPromptOrigin: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const mockSysRedis = redisMock.sysRedis;

const HARD_PROMPT = 'nude, young stepson';
const SOFT_PROMPT = 'daughter';

const row = (prompt: string, overrides: Record<string, unknown> = {}) => ({
  prompt,
  negativePrompt: '',
  source: 'Regex',
  remixOfId: null,
  inputImages: [],
  inputVideo: null,
  time: '2026-01-01 00:00:00',
  ...overrides,
});

// Matches the shape the over-length path writes.
const overLengthRecord = (head = 'a prompt') =>
  `${head.padEnd(2000, ' ')}… [truncated from 30000 chars]`;

const seededEntries = () =>
  mockSysRedis.rPush.mock.calls.map(([, json]: unknown[]) => JSON.parse(json as string));

beforeEach(() => {
  vi.clearAllMocks();
  mockSysRedis.exists.mockResolvedValue(1);
  mockSysRedis.lLen.mockResolvedValue(1);
});

describe('cold-seeding the blocked-prompt list from the audit log', () => {
  beforeEach(() => {
    mockSysRedis.exists.mockResolvedValue(0);
  });

  const seed = async (rows: ReturnType<typeof row>[]) => {
    mockClickhouseQuery.mockResolvedValue(rows);
    await expect(
      auditPromptServer({ prompt: HARD_PROMPT, userId: 5, isGreen: false })
    ).rejects.toBeDefined();
    return seededEntries();
  };

  it('fills category and matched text from a re-audit of the stored prompt', async () => {
    const [entry] = await seed([row(HARD_PROMPT)]);
    expect(entry).toMatchObject({
      category: 'inappropriate_minor',
      matchedField: 'prompt',
      gateWord: 'nude',
    });
    expect(entry.matchedWord).toEqual(expect.any(String));
    expect(entry.matchedRegex).toEqual(expect.any(String));
  });

  it('leaves a soft block out of the list', async () => {
    const entries = await seed([row(SOFT_PROMPT), row(HARD_PROMPT)]);
    expect(entries.map((e) => e.prompt)).toEqual([HARD_PROMPT]);
  });

  it('leaves an over-length refusal out of the list', async () => {
    const record = overLengthRecord();
    const entries = await seed([row(record), row(HARD_PROMPT)]);
    expect(entries.map((e) => e.prompt)).toEqual([HARD_PROMPT]);
  });

  it('keeps a hard-blocked row that merely carries the marker text', async () => {
    const carrier = `${HARD_PROMPT} … [truncated from 30000 chars]`;
    const entries = await seed([row(carrier)]);
    expect(entries.map((e) => e.prompt)).toEqual([carrier]);
    expect(entries[0].category).toBe('inappropriate_minor');
  });

  it('keeps a full-shape record whose text still re-audits as a hard block', async () => {
    const record = overLengthRecord(HARD_PROMPT);
    const entries = await seed([row(record)]);
    expect(entries.map((e) => e.prompt)).toEqual([record]);
  });

  it('bounds the query and stops once the mute threshold is covered', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`${HARD_PROMPT} ${i}`));
    const entries = await seed(rows);
    const [, ...values] = mockClickhouseQuery.mock.calls[0];
    expect(values).toContain(200);
    expect(entries.length).toBe(10);
    expect(entries[entries.length - 1].prompt).toBe(`${HARD_PROMPT} 0`);
  });

  it('keeps a row the audit does not explain, without inventing evidence', async () => {
    const [entry] = await seed([row('a quiet landscape')]);
    expect(entry.prompt).toBe('a quiet landscape');
    expect(entry.category).toBeUndefined();
    expect(entry.matchedWord).toBeUndefined();
  });

  it('keeps an External row without re-auditing it as a regex block', async () => {
    const [entry] = await seed([row(SOFT_PROMPT, { source: 'External' })]);
    expect(entry).toMatchObject({ prompt: SOFT_PROMPT, source: 'External' });
    expect(entry.category).toBeUndefined();
  });

  it('writes the reset marker when no row was a hard block', async () => {
    await seed([row(SOFT_PROMPT)]);
    expect(mockSysRedis.rPush).not.toHaveBeenCalled();
    expect(mockSysRedis.lPush).toHaveBeenCalledWith(expect.anything(), '__RESET__');
  });
});

describe('a live hard block', () => {
  it('stores the full match evidence on the entry', async () => {
    await expect(
      auditPromptServer({ prompt: `9 year old, ${HARD_PROMPT}`, userId: 5, isGreen: false })
    ).rejects.toBeDefined();

    const stored = JSON.parse(mockSysRedis.lPush.mock.calls[0][1] as string);
    expect(stored).toMatchObject({
      category: 'minor_age',
      matchedField: 'prompt',
    });
    expect(stored.matchedRegex).toEqual(expect.any(String));
    expect(stored.matches.map((m: { category: string }) => m.category)).toEqual([
      'minor_age',
      'inappropriate_minor',
      'inappropriate_minor',
    ]);
    expect(stored.matches[1].gateWord).toBe('nude');
  });

  it('records which field carried the match', async () => {
    await expect(
      auditPromptServer({
        prompt: 'nude woman',
        negativePrompt: 'mature body',
        userId: 5,
        isGreen: false,
      })
    ).rejects.toBeDefined();

    const stored = JSON.parse(mockSysRedis.lPush.mock.calls[0][1] as string);
    expect(stored).toMatchObject({
      category: 'inappropriate_minor',
      matchedField: 'negativePrompt',
    });
  });
});
