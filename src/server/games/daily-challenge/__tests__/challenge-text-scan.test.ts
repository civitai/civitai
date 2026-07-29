import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_NSFW_SCORE_THRESHOLD,
  isChallengeTextNsfw,
} from '~/server/games/daily-challenge/challenge-text-scan';

// Scores below are real XGuard output, captured by replaying every challenge in the corpus (214)
// through the text scanner. Each case names the challenge it came from so the fixtures stay
// traceable to the run that motivated the thresholds.
const scores = (results: Record<string, number>) =>
  Object.entries(results).map(([label, score]) => ({ label, score }));

describe('isChallengeTextNsfw', () => {
  it('flags a green challenge whose theme is overtly sexual (challenge 416)', () => {
    // "cringe / sex / porn / penis" — shipped clean under nsfw@0.75, which is the bug.
    expect(
      isChallengeTextNsfw({ results: scores({ NSFW: 0.5663, Explicit: 0.6231, Suggestive: 0.7554 }) })
    ).toBe(true);
  });

  it('flags on nsfw alone when explicit stays low (challenge 414, "furry butts")', () => {
    expect(
      isChallengeTextNsfw({ results: scores({ NSFW: 0.5721, Explicit: 0.3632, Suggestive: 0.8762 }) })
    ).toBe(true);
  });

  it('leaves a benign challenge alone even when suggestive screams (challenge 400)', () => {
    // "Grandpa Loves to RAVE!" — suggestive fires at 0.65 here, which is why it is not consulted.
    expect(
      isChallengeTextNsfw({ results: scores({ NSFW: 0.3358, Explicit: 0.3834, Suggestive: 0.6529 }) })
    ).toBe(false);
  });

  it('ignores suggestive-only noise on plainly clean themes', () => {
    // "Fractalize Worlds with Fractangles" / "Rainbow Unicorn" both trip suggestive.
    expect(
      isChallengeTextNsfw({ results: scores({ NSFW: 0.11, Explicit: 0.08, Suggestive: 0.507 }) })
    ).toBe(false);
  });

  it('does not flag text with no adult content, whatever the challenge is rated', () => {
    // Challenge 73 is rated XXX by a moderator, but its text is "broken hearts, wilted roses".
    expect(
      isChallengeTextNsfw({ results: scores({ NSFW: 0.284, Explicit: 0.2308, Suggestive: 0.5502 }) })
    ).toBe(false);
  });

  it('treats a score exactly at the threshold as a flag', () => {
    expect(
      isChallengeTextNsfw({ results: scores({ NSFW: CHALLENGE_NSFW_SCORE_THRESHOLD }) })
    ).toBe(true);
  });

  it('still escalates on a triggered label when scores are unavailable', () => {
    // Defensive: the orchestrator already decided, so honour it even with no per-label scores.
    expect(isChallengeTextNsfw({ results: [], triggeredLabels: ['NSFW'] })).toBe(true);
    expect(isChallengeTextNsfw({ results: undefined, triggeredLabels: ['Explicit'] })).toBe(true);
  });

  it('ignores labels the challenge scan does not act on', () => {
    expect(
      isChallengeTextNsfw({ results: scores({ Celebrity: 0.99 }), triggeredLabels: ['Celebrity'] })
    ).toBe(false);
    // Suggestive triggering at the registry threshold must not escalate either.
    expect(
      isChallengeTextNsfw({ results: scores({ Suggestive: 0.99 }), triggeredLabels: ['Suggestive'] })
    ).toBe(false);
  });

  it('returns false for missing or malformed output rather than throwing', () => {
    expect(isChallengeTextNsfw({})).toBe(false);
    expect(isChallengeTextNsfw({ results: null })).toBe(false);
    expect(isChallengeTextNsfw({ results: [{ label: null, score: 0.99 }] })).toBe(false);
    expect(isChallengeTextNsfw({ results: [{ label: 'NSFW', score: null }] })).toBe(false);
  });
});
