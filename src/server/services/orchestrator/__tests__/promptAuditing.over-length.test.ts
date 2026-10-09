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

const { mockStripBenignPhrases, mockModeratePrompt, mockProhibited, mockApplyPendingReviewMute } =
  vi.hoisted(() => ({
    mockStripBenignPhrases: vi.fn(async (text: string | undefined) => text),
    mockModeratePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
    mockProhibited: vi.fn(),
    mockApplyPendingReviewMute: vi.fn(async () => undefined),
  }));

vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: mockStripBenignPhrases,
}));
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: { moderatePrompt: mockModeratePrompt },
}));
vi.mock('~/server/services/user-restriction.service', () => ({
  applyPendingReviewMute: mockApplyPendingReviewMute,
}));

import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { MAX_AUDIT_PROMPT_LENGTH } from '~/utils/metadata/audit';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const sysRedis = redisMock.sysRedis;

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
  track: { prohibitedRequest: mockProhibited, userActivity: vi.fn(async () => undefined) },
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
    expect(mockProhibited).toHaveBeenCalledWith(expect.objectContaining({ source: 'Regex' }));
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

/**
 * An over-length refusal is a SIZE refusal: the regex layer returns before any detector runs, so
 * it is not evidence the prompt was prohibited. It must not move the auto-mute counter, and the
 * unbounded payload it exists to stop must not be stored whole.
 *
 * The counter is primed so that ONE more counted block crosses the mute threshold (8): the stored
 * list already reports 9 entries. A path that wrote the counter would therefore both auto-mute and
 * append the "muted" tail — which the positive control below shows it does for a real hard block.
 */
describe('auditPromptServer — an over-length refusal is not content evidence (off green)', () => {
  // The literal recorded form: the first 2,000 characters plus a marker naming the full length.
  const recorded = (text: string) =>
    `${text.slice(0, 2000)}… [truncated from ${text.length} chars]`;

  beforeEach(() => {
    sysRedis.exists.mockResolvedValue(1);
    sysRedis.lRange.mockResolvedValue([]);
    sysRedis.lLen.mockResolvedValue(9);
  });

  it('positive control: a normal hard regex block DOES write the counter and auto-mutes', async () => {
    const prompt = 'portrait of' + BANNED;

    await expect(auditPromptServer(optionsFor(prompt))).rejects.toThrow(
      /celebrity names\. Your account has been muted\.$/
    );
    expect(sysRedis.lPush).toHaveBeenCalledTimes(1);
    expect(mockApplyPendingReviewMute).toHaveBeenCalledTimes(1);
    expect(mockProhibited).toHaveBeenCalledWith(expect.objectContaining({ prompt }));
  });

  it('records a truncated prompt, with no counter write, no mute and no escalation tail', async () => {
    const prompt = benign(MAX_AUDIT_PROMPT_LENGTH + 1234);
    expect(prompt.length).toBe(21234);

    const err = await auditPromptServer(optionsFor(prompt)).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err?.message).toBe(
      'Your prompt was flagged: Prompt exceeds the maximum allowed length (20,000 characters)'
    );

    expect(sysRedis.lPush).not.toHaveBeenCalled();
    expect(mockApplyPendingReviewMute).not.toHaveBeenCalled();
    expect(mockProhibited).toHaveBeenCalledTimes(1);
    const reported = mockProhibited.mock.calls[0][0] as { prompt: string; negativePrompt: string };
    expect(reported.prompt).toBe(recorded(prompt));
    expect(reported.prompt).toHaveLength(2000 + '… [truncated from 21234 chars]'.length);
    expect(reported.prompt.endsWith('… [truncated from 21234 chars]')).toBe(true);
    expect(reported.negativePrompt).toBe('');
    expect(mockProhibited).toHaveBeenCalledWith(expect.objectContaining({ source: 'Regex' }));
  });

  // Boundary: exactly 2,000 characters is recorded as written, with no marker.
  it('records a prompt of exactly 2,000 characters unchanged beside an over-length negative', async () => {
    const prompt = benign(2000);
    const negativePrompt = benign(MAX_AUDIT_PROMPT_LENGTH + 1);

    await expect(auditPromptServer(optionsFor(prompt, { negativePrompt }))).rejects.toThrow(
      /maximum allowed length/
    );
    expect(mockProhibited).toHaveBeenCalledWith(
      expect.objectContaining({ prompt, negativePrompt: recorded(negativePrompt) })
    );
    expect((mockProhibited.mock.calls[0][0] as { prompt: string }).prompt).toHaveLength(2000);
  });

  it('truncates an over-length NEGATIVE prompt and leaves a short prompt as written', async () => {
    const negativePrompt = benign(MAX_AUDIT_PROMPT_LENGTH) + BANNED;

    await expect(
      auditPromptServer(optionsFor('a serene mountain landscape', { negativePrompt }))
    ).rejects.toThrow(/^Your prompt was flagged: Prompt exceeds the maximum allowed length/);

    expect(sysRedis.lPush).not.toHaveBeenCalled();
    expect(mockApplyPendingReviewMute).not.toHaveBeenCalled();
    expect(mockProhibited).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'a serene mountain landscape',
        negativePrompt: recorded(negativePrompt),
      })
    );
  });
});
