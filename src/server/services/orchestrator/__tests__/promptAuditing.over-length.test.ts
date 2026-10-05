import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Over-length input must be REFUSED by `auditPromptServer`, not handed to the external
 * classifier alone.
 *
 * `auditPromptEnriched` refuses anything longer than `MAX_AUDIT_PROMPT_LENGTH` instead of
 * scanning a truncated copy (#2727 M2), because truncate-then-scan let a banned term buried
 * past the cap evade the regex layer. That refusal used to carry NO triggers, and
 * `auditPromptServer` only throws a regex block when `triggers.length > 0` — so an over-length
 * prompt skipped the regex layer entirely and was left to the external classifier alone. These
 * tests run the REAL `auditPromptEnriched` (only the classifier, the
 * benign-phrase store and I/O are mocked) so the seam between the two functions is what is
 * under test.
 *
 * The classifier is mocked to return not-flagged, or to reject, in every over-length case:
 * either way the prompt must still be refused, because the refusal has to come from the regex
 * layer and not from the classifier.
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

import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { MAX_AUDIT_PROMPT_LENGTH } from '~/utils/metadata/audit';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/redis.mock';

const OVER_LENGTH = /maximum allowed length/;

// Benign filler of an exact length. Real words separated by spaces rather than one long run, so
// the boundary cases exercise the detectors the way a pasted prompt would.
const benign = (length: number) => 'a serene mountain landscape, '.repeat(length).slice(0, length);

// `tom cruise` is a real words-poi.json entry: the detector genuinely fires on it in-cap.
const BANNED = ' tom cruise portrait';

const optionsFor = (
  prompt: string,
  extra: { negativePrompt?: string; isGreen?: boolean; acknowledgedSoftBlock?: boolean } = {}
) => ({
  prompt,
  negativePrompt: extra.negativePrompt ?? '',
  userId: 5,
  isGreen: extra.isGreen ?? false,
  acknowledgedSoftBlock: extra.acknowledgedSoftBlock,
  track: { prohibitedRequest: mockProhibited },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockStripBenignPhrases.mockImplementation(async (text: string | undefined) => text);
  mockModeratePrompt.mockImplementation(async () => ({ flagged: false, categories: [] }));
});

describe('auditPromptServer — over-length input is refused by the regex layer', () => {
  it('control: the banned term is blocked when it sits inside the cap', async () => {
    await expect(auditPromptServer(optionsFor('portrait of' + BANNED))).rejects.toThrow(
      /celebrity names/
    );
  });

  it('refuses a banned term buried past the cap while the classifier says not-flagged', async () => {
    const prompt = benign(MAX_AUDIT_PROMPT_LENGTH) + BANNED;
    expect(prompt.length).toBeGreaterThan(MAX_AUDIT_PROMPT_LENGTH);

    await expect(auditPromptServer(optionsFor(prompt))).rejects.toThrow(OVER_LENGTH);
    // A hard regex block short-circuits ahead of the classifier.
    expect(mockModeratePrompt).not.toHaveBeenCalled();
  });

  it('refuses an over-length prompt with NO banned term while the classifier errors', async () => {
    mockModeratePrompt.mockImplementation(async () => {
      throw new Error('classifier unavailable');
    });
    const prompt = benign(MAX_AUDIT_PROMPT_LENGTH + 5000);

    await expect(auditPromptServer(optionsFor(prompt))).rejects.toThrow(OVER_LENGTH);
  });

  it('allows exactly MAX_AUDIT_PROMPT_LENGTH characters (boundary)', async () => {
    const prompt = benign(MAX_AUDIT_PROMPT_LENGTH);
    expect(prompt.length).toBe(20000);

    await expect(auditPromptServer(optionsFor(prompt))).resolves.toBeUndefined();
    expect(mockModeratePrompt).toHaveBeenCalledTimes(1);
    expect(mockProhibited).not.toHaveBeenCalled();
  });

  it('refuses MAX_AUDIT_PROMPT_LENGTH + 1 characters (boundary)', async () => {
    const prompt = benign(MAX_AUDIT_PROMPT_LENGTH + 1);
    expect(prompt.length).toBe(20001);

    await expect(auditPromptServer(optionsFor(prompt))).rejects.toThrow(OVER_LENGTH);
  });

  it('refuses an over-length NEGATIVE prompt alongside a short benign prompt', async () => {
    const negativePrompt = benign(MAX_AUDIT_PROMPT_LENGTH) + BANNED;

    await expect(
      auditPromptServer(optionsFor('a serene mountain landscape', { negativePrompt }))
    ).rejects.toThrow(OVER_LENGTH);
  });

  it('is a HARD block: no soft-block override flag, and it is recorded as a regex block', async () => {
    const prompt = benign(MAX_AUDIT_PROMPT_LENGTH + 1);

    const err = await auditPromptServer(optionsFor(prompt)).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err, 'auditPromptServer resolved instead of refusing').toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(OVER_LENGTH);
    expect((err as { cause?: { softBlock?: boolean } }).cause?.softBlock).toBeUndefined();
    expect(mockProhibited).toHaveBeenCalledTimes(1);
    expect(mockProhibited).toHaveBeenCalledWith(
      expect.objectContaining({ prompt, source: 'Regex' })
    );
  });

  // The behaviour a soft classification would actually break: the soft-block click-through.
  it('cannot be clicked through with acknowledgedSoftBlock', async () => {
    const prompt = benign(MAX_AUDIT_PROMPT_LENGTH + 1);

    await expect(
      auditPromptServer(optionsFor(prompt, { acknowledgedSoftBlock: true }))
    ).rejects.toThrow(OVER_LENGTH);
  });

  it('is refused on the green domain too (without recording a prohibited request)', async () => {
    const prompt = benign(MAX_AUDIT_PROMPT_LENGTH + 1);

    await expect(auditPromptServer(optionsFor(prompt, { isGreen: true }))).rejects.toThrow(
      OVER_LENGTH
    );
    expect(mockProhibited).not.toHaveBeenCalled();
  });
});
