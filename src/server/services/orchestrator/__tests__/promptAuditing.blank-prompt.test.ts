import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An empty prompt must not skip the audit of a non-empty negative prompt.
 *
 * `auditPromptServer`, `classifyPromptServer` and `auditPromptEnriched` each had an empty-input
 * fast path keyed on the prompt alone, so an empty prompt returned before the negative prompt was
 * looked at. All three now share `isBlankAuditInput`, which requires BOTH fields to be empty.
 *
 * These run the REAL `auditPromptEnriched` (only the classifier, the benign-phrase store and I/O
 * are mocked), so the seam between the server wrappers and the regex layer is what is under test.
 */

const { mockStripBenignPhrases, mockModeratePrompt, mockProhibited } = vi.hoisted(() => ({
  mockStripBenignPhrases: vi.fn(async (text: string | undefined) => text),
  mockModeratePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
  mockProhibited: vi.fn(),
}));

vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: mockStripBenignPhrases,
}));
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: mockModeratePrompt },
}));
vi.mock('~/server/services/user-restriction.service', () => ({
  applyPendingReviewMute: vi.fn(async () => undefined),
}));

import {
  auditPromptServer,
  classifyPromptServer,
} from '~/server/services/orchestrator/promptAuditing';
import { MAX_AUDIT_PROMPT_LENGTH } from '~/utils/metadata/audit';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/redis.mock';

// `tom cruise` is a real words-poi.json entry; the negative-prompt POI check fires on it.
const POI_NEGATIVE = 'tom cruise portrait';
const OVER_LENGTH = /maximum allowed length/;
const benign = (length: number) => 'a serene mountain landscape, '.repeat(length).slice(0, length);

const optionsFor = (prompt: string, negativePrompt?: string, isGreen = false) => ({
  prompt,
  negativePrompt,
  userId: 5,
  isGreen,
  track: { prohibitedRequest: mockProhibited, userActivity: vi.fn(async () => undefined) },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockStripBenignPhrases.mockImplementation(async (text: string | undefined) => text);
  mockModeratePrompt.mockImplementation(async () => ({ flagged: false, categories: [] }));
});

describe('auditPromptServer — empty prompt, non-empty negative prompt', () => {
  it('control: a celebrity name in the negative prompt is refused beside a non-empty prompt', async () => {
    await expect(auditPromptServer(optionsFor('landscape', POI_NEGATIVE))).rejects.toThrow(
      /^Your prompt was flagged: Negative prompt cannot include celebrity names/
    );
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '  \n '],
  ])('refuses a celebrity name in the negative prompt (prompt: %s)', async (_l, prompt) => {
    await expect(auditPromptServer(optionsFor(prompt, POI_NEGATIVE))).rejects.toThrow(
      /^Your prompt was flagged: Negative prompt cannot include celebrity names/
    );
    // Recorded like any other hard regex block off green.
    expect(mockProhibited).toHaveBeenCalledWith(
      expect.objectContaining({ prompt, negativePrompt: POI_NEGATIVE, source: 'Regex' })
    );
  });

  it('refuses it on the green domain too', async () => {
    await expect(auditPromptServer(optionsFor('', POI_NEGATIVE, true))).rejects.toThrow(
      /Negative prompt cannot include celebrity names/
    );
  });

  it('refuses an over-length negative prompt', async () => {
    await expect(
      auditPromptServer(optionsFor('', benign(MAX_AUDIT_PROMPT_LENGTH + 1)))
    ).rejects.toThrow(OVER_LENGTH);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '  \n '],
  ])(
    'passes a benign negative prompt without calling the external classifier (prompt: %s)',
    async (_l, prompt) => {
      await expect(
        auditPromptServer(optionsFor(prompt, 'blurry, low quality'))
      ).resolves.toBeUndefined();
      // The classifier is only ever sent the prompt, and there is none to send.
      expect(mockModeratePrompt).not.toHaveBeenCalled();
      expect(mockProhibited).not.toHaveBeenCalled();
    }
  );
});

/**
 * A non-empty prompt made up only of moderator-whitelisted phrases reaches the regex layer blank,
 * because `classifyPromptServer` audits the benign-stripped copy. Its negative prompt is now
 * audited too — the same fast-path rule, reached through stripping rather than an empty field.
 * The classifier, keyed on the RAW prompt, is still called exactly as before.
 */
describe('a prompt that benign-phrase stripping empties', () => {
  const PROMPT = 'teen titans';
  beforeEach(() => {
    mockStripBenignPhrases.mockImplementation(async (text: string | undefined) =>
      text === PROMPT ? ' ' : text
    );
  });

  it('has its negative prompt audited', async () => {
    await expect(auditPromptServer(optionsFor(PROMPT, POI_NEGATIVE))).rejects.toThrow(
      /Negative prompt cannot include celebrity names/
    );
  });

  // Invariant guard (held before the change): pins that the classifier skip keys on the RAW
  // prompt, not on the stripped copy.
  it('still reaches the external classifier with the stripped copy, as before', async () => {
    await expect(auditPromptServer(optionsFor(PROMPT, 'blurry'))).resolves.toBeUndefined();
    expect(mockModeratePrompt).toHaveBeenCalledTimes(1);
    expect(mockModeratePrompt).toHaveBeenCalledWith(' ', undefined);
  });
});

describe('classifyPromptServer — empty prompt, non-empty negative prompt', () => {
  it('returns a hard regex verdict for a celebrity name in the negative prompt', async () => {
    const verdict = await classifyPromptServer({
      prompt: '',
      negativePrompt: POI_NEGATIVE,
      isGreen: false,
    });
    expect(verdict).toEqual({
      outcome: 'hard',
      source: 'regex',
      triggers: [
        {
          category: 'poi',
          message: 'Negative prompt cannot include celebrity names',
          matchedWord: 'tom cruise',
        },
      ],
      blockedFor: ['Negative prompt cannot include celebrity names'],
      categories: [],
      externalError: null,
    });
    expect(mockModeratePrompt).not.toHaveBeenCalled();
  });

  it('control (through auditPromptServer): a non-empty prompt with no negative prompt is audited and classified', async () => {
    await expect(auditPromptServer(optionsFor('a red fox', undefined))).resolves.toBeUndefined();
    expect(mockModeratePrompt).toHaveBeenCalledWith('a red fox', undefined);
    await expect(auditPromptServer(optionsFor('tom cruise portrait', ''))).rejects.toThrow(
      /celebrity names/
    );
  });

  it('control: a non-empty prompt still reaches the external classifier with the prompt text', async () => {
    await classifyPromptServer({
      prompt: 'a red fox',
      negativePrompt: 'blurry',
      isGreen: false,
    });
    expect(mockModeratePrompt).toHaveBeenCalledTimes(1);
    expect(mockModeratePrompt).toHaveBeenCalledWith('a red fox', undefined);
  });
});

// Invariant guards: these held before the change too. Both fields empty is still the fast path —
// no benign-phrase read, no classifier call, no record.
describe('both fields empty still takes the fast path', () => {
  it.each([
    ['empty, no negative', '', undefined],
    ['empty, empty', '', ''],
    ['whitespace, whitespace', '  ', ' \n '],
  ])('auditPromptServer resolves with no reads (%s)', async (_l, prompt, negativePrompt) => {
    await expect(auditPromptServer(optionsFor(prompt, negativePrompt))).resolves.toBeUndefined();
    expect(mockStripBenignPhrases).not.toHaveBeenCalled();
    expect(mockModeratePrompt).not.toHaveBeenCalled();
    expect(mockProhibited).not.toHaveBeenCalled();
  });

  it('classifyPromptServer passes with no reads', async () => {
    const verdict = await classifyPromptServer({ prompt: '', negativePrompt: '', isGreen: true });
    expect(verdict.outcome).toBe('pass');
    expect(mockStripBenignPhrases).not.toHaveBeenCalled();
    expect(mockModeratePrompt).not.toHaveBeenCalled();
  });
});
