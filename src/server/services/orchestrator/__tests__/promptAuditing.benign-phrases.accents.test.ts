import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A moderator-whitelisted phrase must stay whitelisted when the creator spells it with an
 * accent. `auditPromptEnriched` folds accents (`normalizeText`) before the detector runs, so
 * the strip has to run over that same folded text — stripping the RAW prompt matched one
 * alphabet while the detector read another, and `émma stone` was blocked while the identical
 * plain spelling was allowed.
 *
 * 🔴 If this file fails, do NOT repair it by handing `stripBenignPhrases` the raw prompt
 * again. That is the defect, and it goes green. The plain-ASCII case below is the control:
 * it passes with and without the fix, so a run where only the accented case fails is the
 * ordering bug and nothing else.
 *
 * The source guard from #4375 cannot see this path — it scans `includesPoi(` call sites and
 * the POI check here lives inside `auditPromptEnriched`. This behavioural test is the guard.
 */

const { mockStripBenignPhrases, mockModeratePrompt, mockProhibited } = vi.hoisted(() => ({
  mockStripBenignPhrases: vi.fn(),
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
import { buildBenignPhraseRegex, stripBenignPhrasesWith } from '~/shared/utils/benign-phrases';
import { includesPoi } from '~/utils/metadata/audit';
import { normalizeText } from '~/utils/normalize-text';
import '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/redis.mock';

// `emma stone` is a real entry in words-poi.json, so the detector genuinely fires on it —
// the whitelist is the only thing that can clear these prompts.
const WHITELIST = ['emma stone'];

// What both spellings must audit down to: the phrase blanked to one space, the separator that
// preceded `portrait` still there. Measured, not guessed — an earlier single-space guess failed.
const AUDITED = '  portrait';

const optionsFor = (prompt: string) => ({
  prompt,
  negativePrompt: '',
  userId: 5,
  isGreen: false,
  track: { prohibitedRequest: mockProhibited },
});

beforeEach(() => {
  vi.clearAllMocks();
  const pattern = buildBenignPhraseRegex(WHITELIST);
  mockStripBenignPhrases.mockImplementation(async (text: string | undefined) =>
    stripBenignPhrasesWith(text, pattern)
  );
});

describe('auditPromptServer — a whitelisted phrase stays whitelisted when accented', () => {
  it('the detector fires on both spellings without the whitelist', () => {
    expect(includesPoi(normalizeText('emma stone portrait'))).toBe('emma stone');
    expect(includesPoi(normalizeText('émma stone portrait'))).toBe('emma stone');
  });

  // Asserting the audited text, not just that the promise resolved. `moderatePrompt` is the
  // last consumer of the audited copy, so its argument IS that copy — which pins that exactly
  // the phrase was blanked. `resolves` alone stays green if a future strip swallows the whole
  // prompt, and an empty audited prompt short-circuits the detector into success for anything.
  // The second argument is the OBSERVABILITY-ONLY `moderationSource` label. It is `undefined`
  // here because these options declare none, which is the point: an undeclared caller must not
  // be labelled `generate`. Asserted at full arity rather than relaxed to a first-argument
  // check, so this still pins exactly what `moderatePrompt` is handed.
  it('allows the plain spelling (control — green with and without the fix)', async () => {
    await expect(auditPromptServer(optionsFor('emma stone portrait'))).resolves.toBeUndefined();
    expect(mockModeratePrompt).toHaveBeenCalledWith(AUDITED, undefined);
    expect(mockProhibited).not.toHaveBeenCalled();
  });

  it('allows the accented spelling', async () => {
    await expect(auditPromptServer(optionsFor('émma stone portrait'))).resolves.toBeUndefined();
    expect(mockModeratePrompt).toHaveBeenCalledWith(AUDITED, undefined);
    expect(mockProhibited).not.toHaveBeenCalled();
  });

  // `toThrow(/celebrity names/)` rather than a bare `toThrow`: the catch in auditPromptServer is
  // blanket, so a TypeError from a broken mock also rejects and a bare matcher calls that a pass
  // on a run where the POI gate never fired.
  it('still blocks a POI name that is NOT whitelisted, accented or not', async () => {
    await expect(auditPromptServer(optionsFor('tom cruise portrait'))).rejects.toThrow(
      /celebrity names/
    );
    await expect(auditPromptServer(optionsFor('tóm cruise portrait'))).rejects.toThrow(
      /celebrity names/
    );
  });

  // The only place in the suite where raw-vs-normalized is observable: every other prompt
  // constant is pure ASCII, so `normalizeText` is the identity on it and an assertion naming
  // the raw text passes either way. Reporting must keep the accent — it is the evidence a
  // moderator needs on an obfuscated prompt.
  it('reports the RAW prompt, accent intact, when the audit blocks', async () => {
    await expect(auditPromptServer(optionsFor('tóm cruise portrait'))).rejects.toThrow(
      /celebrity names/
    );

    expect(mockProhibited).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'tóm cruise portrait' })
    );
  });
});
