import { describe, expect, it } from 'vitest';
import {
  decideFromObservations,
  isNsfwLevelAllowed,
  resolveRejectionMessage,
} from '~/server/services/ai/collection-review.service';
import type { AiReviewObservations } from '~/server/services/ai/collection-review.service';
import { NsfwLevel } from '~/server/common/enums';

const clean: AiReviewObservations = {
  sexualContent: false,
  suggestiveStyling: false,
  nsfwEstimate: 'PG',
  depictsMinor: false,
  minorIsPhotorealistic: false,
  minorInappropriate: false,
  depictsRealPerson: false,
  otherViolations: [],
  hasBuzzReference: true,
};

describe('decideFromObservations', () => {
  it('approves a clean submission', () => {
    expect(decideFromObservations(clean).decision).toBe('approve');
  });

  it('rejects visible sexual content', () => {
    const result = decideFromObservations({ ...clean, sexualContent: true });
    expect(result.decision).toBe('reject');
    expect(result.violations).toContain('sexual/adult content');
  });

  it('rejects a missing buzz reference', () => {
    const result = decideFromObservations({ ...clean, hasBuzzReference: false });
    expect(result.decision).toBe('reject');
    expect(result.violations).toContain('no buzz reference');
  });

  it.each(['photorealistic minor', 'minor depicted inappropriately', 'real person likeness'])(
    'escalates rather than rejects for %s',
    (expected) => {
      const observations: AiReviewObservations =
        expected === 'real person likeness'
          ? { ...clean, depictsRealPerson: true }
          : {
              ...clean,
              depictsMinor: true,
              minorIsPhotorealistic: expected === 'photorealistic minor',
              minorInappropriate: expected === 'minor depicted inappropriately',
            };
      const result = decideFromObservations(observations);
      expect(result.decision).toBe('escalate');
      expect(result.escalations).toContain(expected);
    }
  );

  it('treats a stylized minor in a wholesome context as approvable', () => {
    const result = decideFromObservations({ ...clean, depictsMinor: true });
    expect(result.decision).toBe('approve');
  });

  it('escalates suggestive styling instead of rejecting it', () => {
    const result = decideFromObservations({ ...clean, suggestiveStyling: true });
    expect(result.decision).toBe('escalate');
    expect(result.escalations).toContain('suggestive styling');
  });

  it('accepts known violation categories case-insensitively', () => {
    const result = decideFromObservations({ ...clean, otherViolations: ['Graphic Violence'] });
    expect(result.decision).toBe('reject');
    expect(result.violations).toContain('graphic violence');
  });

  it('escalates categories the model invented rather than rejecting on them', () => {
    const result = decideFromObservations({ ...clean, otherViolations: ['profanity'] });
    expect(result.decision).toBe('escalate');
    expect(result.violations).toHaveLength(0);
    expect(result.escalations[0]).toContain('profanity');
  });

  // Every rejection reaches a submitter, so none may resolve to model-authored text.
  it('never produces a rejection without curated copy', () => {
    const bools = [true, false];
    const categories = [[], ['graphic violence'], ['profanity'], ['self-harm', 'made up thing']];
    let rejections = 0;

    for (const sexualContent of bools)
      for (const suggestiveStyling of bools)
        for (const depictsMinor of bools)
          for (const minorIsPhotorealistic of bools)
            for (const minorInappropriate of bools)
              for (const depictsRealPerson of bools)
                for (const hasBuzzReference of bools)
                  for (const otherViolations of categories) {
                    const result = decideFromObservations({
                      ...clean,
                      sexualContent,
                      suggestiveStyling,
                      depictsMinor,
                      minorIsPhotorealistic,
                      minorInappropriate,
                      depictsRealPerson,
                      hasBuzzReference,
                      otherViolations,
                    });
                    if (result.decision !== 'reject') continue;
                    rejections++;
                    const message = resolveRejectionMessage(result.violations);
                    expect(message).not.toContain('made up thing');
                    expect(message).not.toContain('unrecognized category');
                    expect(message.length).toBeGreaterThan(20);
                  }

    expect(rejections).toBeGreaterThan(0);
  });
});

describe('resolveRejectionMessage', () => {
  it('prefers collection-configured copy over the default', () => {
    const message = resolveRejectionMessage(['no buzz reference'], {
      'no buzz reference': 'Needs a bolt!',
    });
    expect(message).toBe('Needs a bolt!');
  });

  it('falls back to a generic message when there is no violation', () => {
    expect(resolveRejectionMessage([])).toContain("wasn't accepted");
  });
});

describe('isNsfwLevelAllowed', () => {
  const allowed = NsfwLevel.PG | NsfwLevel.PG13;

  it.each([
    [NsfwLevel.PG, true],
    [NsfwLevel.PG13, true],
    [NsfwLevel.R, false],
    [NsfwLevel.X, false],
    [NsfwLevel.XXX, false],
    [NsfwLevel.Blocked, false],
  ])('level %i -> %s', (level, expected) => {
    expect(isNsfwLevelAllowed(level, allowed)).toBe(expected);
  });

  // Unrated images have no bit set; the job must skip them rather than read 0 as "disallowed".
  it('reports an unrated image as not allowed', () => {
    expect(isNsfwLevelAllowed(0, allowed)).toBe(false);
  });
});
