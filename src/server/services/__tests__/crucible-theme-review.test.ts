import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import { THEME_DISQUALIFY_THRESHOLD } from '~/server/games/daily-challenge/daily-challenge-scoring';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import type * as GenerativeContent from '~/server/games/daily-challenge/generative-content';
import type * as CrucibleEntryAccepted from '~/server/services/crucible-entry-accepted';
import type * as CrucibleService from '~/server/services/crucible.service';
import type * as ReportService from '~/server/services/report.service';

const generateReview = vi.fn();
const getJudgingConfig = vi.fn();
const acceptCrucibleEntry = vi.fn();
const removeCrucibleEntryForThemeReview = vi.fn();
const createReport = vi.fn();

vi.mock('~/server/games/daily-challenge/generative-content', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerativeContent>()),
  generateReview,
}));
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof DailyChallengeUtils>()),
  getJudgingConfig,
}));
vi.mock('~/server/services/crucible-entry-accepted', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEntryAccepted>()),
  acceptCrucibleEntry,
}));
vi.mock('~/server/services/crucible.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleService>()),
  removeCrucibleEntryForThemeReview,
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  createReport,
}));

const { MAX_UNSCORED_ATTEMPTS, runCrucibleThemeReview, themeActions, themeVerdict } = await import(
  '~/server/services/crucible-theme-review'
);

const CONFIG_KEY = 'system:crucible-theme-review';
const FAIL = THEME_DISQUALIFY_THRESHOLD - 1;
const PASS = THEME_DISQUALIFY_THRESHOLD;

const hashes = new Map<string, Map<string, string>>();
let config: Record<string, unknown> = {};

const entry = (entryId: number) => ({
  entryId,
  crucibleId: 7,
  userId: 100 + entryId,
  crucibleName: 'Hats',
  crucibleNsfwLevel: 1,
  imageId: 1000 + entryId,
  url: `img-${entryId}`,
  username: `user${entryId}`,
});

const setMode = (mode: string, extra: Record<string, unknown> = {}) => {
  config = { crucibles: { '7': { theme: 'Party hats', judgeId: 3, mode, ...extra } } };
};
const scoreTheme = (theme: unknown) =>
  generateReview.mockResolvedValue({
    score: theme === undefined ? {} : { theme },
    summary: 'a hat',
    model: 'test-model',
    usage: { promptTokens: 0, completionTokens: 0 },
  });

beforeEach(() => {
  vi.clearAllMocks();
  hashes.clear();
  setMode('enforce');
  const { sysRedis } = redisMock;
  sysRedis.get.mockImplementation(async (key: string) =>
    key === CONFIG_KEY ? JSON.stringify(config) : null
  );
  sysRedis.hGetAll.mockImplementation(async (key: string) =>
    Object.fromEntries(hashes.get(key) ?? [])
  );
  sysRedis.hSet.mockImplementation(async (key: string, field: string, value: string) => {
    const hash = hashes.get(key) ?? new Map<string, string>();
    hash.set(field, value);
    hashes.set(key, hash);
    return 1;
  });
  sysRedis.expire.mockResolvedValue(true);
  dbMock.dbRead.$queryRaw.mockResolvedValue([entry(1)]);
  getJudgingConfig.mockResolvedValue({ judgeId: 3, userId: 9, prompts: {} });
  acceptCrucibleEntry.mockResolvedValue(true);
  removeCrucibleEntryForThemeReview.mockResolvedValue({});
  createReport.mockResolvedValue({ id: 1 });
});

describe('themeVerdict', () => {
  it('fails only a numeric theme score under the disqualify threshold', () => {
    expect(themeVerdict({ theme: FAIL })).toEqual({ verdict: 'fail', theme: FAIL });
    expect(themeVerdict({ Theme: PASS })).toEqual({ verdict: 'pass', theme: PASS });
  });

  it('never fails a review without a numeric theme score', () => {
    for (const score of [null, undefined, {}, { theme: null }, { theme: '1' }, [FAIL]])
      expect(themeVerdict(score)).toEqual({ verdict: 'unscored' });
  });
});

describe('themeActions', () => {
  it.each([
    ['shadow', 'fail', 1, ['accepted']],
    ['flag', 'pass', 1, ['accepted']],
    ['flag', 'fail', 1, ['reported', 'accepted']],
    ['enforce', 'fail', 1, ['removed']],
    ['enforce', 'unscored', 1, ['retry']],
    ['enforce', 'unscored', MAX_UNSCORED_ATTEMPTS, ['reported', 'accepted']],
  ] as const)('%s + %s on attempt %d → %j', (mode, verdict, attempt, actions) => {
    expect(themeActions(mode, verdict, attempt)).toEqual(actions);
  });
});

describe('runCrucibleThemeReview', () => {
  it('removes an off-theme entry under enforce, and never accepts it', async () => {
    scoreTheme(FAIL);

    await runCrucibleThemeReview();

    expect(removeCrucibleEntryForThemeReview).toHaveBeenCalledWith(
      expect.objectContaining({ entryId: 1 })
    );
    expect(acceptCrucibleEntry).not.toHaveBeenCalled();
  });

  it('accepts a passing entry once, and reviews it no more', async () => {
    scoreTheme(PASS);

    await runCrucibleThemeReview();
    await runCrucibleThemeReview();

    expect(generateReview).toHaveBeenCalledTimes(1);
    expect(acceptCrucibleEntry).toHaveBeenCalledWith({ entryId: 1, crucibleId: 7, userId: 101 });
  });

  it('reports and accepts an off-theme entry under flag, so a moderator keeping it costs nothing', async () => {
    setMode('flag');
    scoreTheme(FAIL);

    await runCrucibleThemeReview();

    expect(createReport).toHaveBeenCalledWith(expect.objectContaining({ id: 1001 }));
    expect(acceptCrucibleEntry).toHaveBeenCalledWith({ entryId: 1, crucibleId: 7, userId: 101 });
    expect(removeCrucibleEntryForThemeReview).not.toHaveBeenCalled();
  });

  it('retries an unscored entry, then reports and accepts it', async () => {
    scoreTheme(undefined);

    for (let run = 0; run < MAX_UNSCORED_ATTEMPTS + 1; run++) await runCrucibleThemeReview();

    expect(generateReview).toHaveBeenCalledTimes(MAX_UNSCORED_ATTEMPTS);
    expect(createReport).toHaveBeenCalledTimes(1);
    expect(acceptCrucibleEntry).toHaveBeenCalledTimes(1);
    expect(removeCrucibleEntryForThemeReview).not.toHaveBeenCalled();
  });

  it('tries an entry again when its review fails', async () => {
    generateReview.mockRejectedValue(new Error('down'));
    await runCrucibleThemeReview();

    scoreTheme(PASS);
    await runCrucibleThemeReview();

    expect(acceptCrucibleEntry).toHaveBeenCalledTimes(1);
  });

  it('counts a review that throws as an attempt, then reports and accepts the entry', async () => {
    generateReview.mockRejectedValue(new Error('json_parse'));

    for (let run = 0; run < MAX_UNSCORED_ATTEMPTS + 1; run++) await runCrucibleThemeReview();

    expect(createReport).toHaveBeenCalledTimes(1);
    expect(acceptCrucibleEntry).toHaveBeenCalledTimes(1);
  });

  it('reviews a new entry ahead of entries whose reviews keep throwing', async () => {
    const entries = Array.from({ length: 41 }, (_, i) => entry(i + 1));
    dbMock.dbRead.$queryRaw.mockResolvedValue(entries);
    generateReview.mockImplementation(async ({ creator }: { creator: string }) => {
      if (creator !== 'user41') throw new Error('refused');
      return { score: { theme: PASS }, summary: 'a hat', model: 'm', usage: {} };
    });

    await runCrucibleThemeReview();
    await runCrucibleThemeReview();

    expect(acceptCrucibleEntry).toHaveBeenCalledWith({ entryId: 41, crucibleId: 7, userId: 141 });
  });

  it('finishes a half-done entry without a second report or review', async () => {
    scoreTheme(undefined);
    acceptCrucibleEntry.mockRejectedValueOnce(new Error('db down'));

    for (let run = 0; run < MAX_UNSCORED_ATTEMPTS + 2; run++) await runCrucibleThemeReview();

    expect(generateReview).toHaveBeenCalledTimes(MAX_UNSCORED_ATTEMPTS);
    expect(createReport).toHaveBeenCalledTimes(1);
    expect(acceptCrucibleEntry).toHaveBeenCalledTimes(2);
  });

  it("judges with the crucible's own prompt", async () => {
    setMode('enforce', { reviewPrompt: 'Judge hats only.' });
    scoreTheme(PASS);

    await runCrucibleThemeReview();

    expect(getJudgingConfig).toHaveBeenCalledWith(3, 'Judge hats only.');
  });

  it('reviews nothing while the config is unreadable', async () => {
    config = { crucibles: { '7': { theme: 'Party hats', mode: 'enforce' } } };

    await runCrucibleThemeReview();

    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(generateReview).not.toHaveBeenCalled();
  });
});
