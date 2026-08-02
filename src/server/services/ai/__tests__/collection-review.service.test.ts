import { describe, expect, it } from 'vitest';
import {
  decideFromObservations,
  isNsfwLevelAllowed,
  isUnratedNsfwLevel,
  resolveRejectionMessage,
} from '~/server/services/ai/collection-review.service';
import { NsfwLevel } from '~/server/common/enums';

const clean: Record<string, unknown> = {
  sexualContent: false,
  isPhotorealistic: false,
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

  // A response we cannot read is not a clean bill of health. Every one of these is JSON-parseable,
  // so nothing upstream rejects them.
  it.each([
    ['empty object', {}],
    ['a refusal', { error: "I can't assist with that" }],
    ['missing hasBuzzReference', { ...clean, hasBuzzReference: undefined }],
    ['missing sexualContent', { ...clean, sexualContent: undefined }],
    ['missing depictsMinor', { ...clean, depictsMinor: undefined }],
    // Optional here would read as false and silently disable the photorealism gate below.
    ['missing isPhotorealistic', { ...clean, isPhotorealistic: undefined }],
    ['a string where a boolean belongs', { ...clean, sexualContent: 'no' }],
    ['otherViolations as a string', { ...clean, otherViolations: 'graphic violence' }],
    ['null', null],
    ['an array', []],
  ])('escalates rather than approving on %s', (_label, response) => {
    const result = decideFromObservations(response);
    expect(result.decision).toBe('escalate');
    expect(result.escalations).toContain('unreadable model response');
  });

  // These collections are mostly stylized art, which is exactly what the prompt tells the model it
  // may be unsure about. Escalating on the hedge alone would sweep up ordinary submissions.
  it('approves an age-ambiguous subject when nothing else is flagged', () => {
    expect(decideFromObservations({ ...clean, minorUncertain: true }).decision).toBe('approve');
  });

  // rules/minors.md makes photorealism the bright line for minors in ANY context, so an ambiguous
  // age matters there even when the image is otherwise wholesome.
  it.each([
    ['a suggestive context', { suggestiveStyling: true }],
    ['a photorealistic image', { isPhotorealistic: true }],
  ])('escalates an age-ambiguous subject in %s', (_label, overrides) => {
    const result = decideFromObservations({ ...clean, minorUncertain: true, ...overrides });
    expect(result.decision).toBe('escalate');
    expect(result.escalations).toContain('possible minor');
    expect(result.neverReject).toBe(true);
  });

  it('approves an age-ambiguous stylized subject in a wholesome context', () => {
    const result = decideFromObservations({
      ...clean,
      minorUncertain: true,
      isPhotorealistic: false,
    });
    expect(result.decision).toBe('approve');
  });

  // The prompt asks for 'R+', but models reach for the labels they know.
  it.each(['R+', 'R', 'X', 'XXX', 'nsfw'])('treats nsfwEstimate %s as adult content', (rating) => {
    const result = decideFromObservations({ ...clean, nsfwEstimate: rating });
    expect(result.decision).toBe('reject');
    expect(result.violations).toContain('sexual/adult content');
  });

  it.each(['PG', 'PG-13'])('does not treat nsfwEstimate %s as adult content', (rating) => {
    expect(decideFromObservations({ ...clean, nsfwEstimate: rating }).decision).toBe('approve');
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
      const observations =
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

  it.each(['minorIsPhotorealistic', 'minorInappropriate'])(
    'honours %s even when the model only suspects a minor',
    (signal) => {
      const result = decideFromObservations({
        ...clean,
        depictsMinor: false,
        minorUncertain: true,
        [signal]: true,
      });
      expect(result.decision).toBe('escalate');
    }
  );

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
                    // Rendered after the notification's own "wasn't accepted" sentence.
                    expect(message).not.toContain("wasn't accepted");
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
    expect(resolveRejectionMessage([])).toContain("doesn't meet");
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

  // The codebase uses both 0 and -1 for "not yet rated"; neither may pass the mask, and the job
  // must skip them rather than reject them as adult content.
  it.each([0, -1])('reports unrated level %i as not allowed', (level) => {
    expect(isNsfwLevelAllowed(level, allowed)).toBe(false);
    expect(isUnratedNsfwLevel(level)).toBe(true);
  });
});

describe('neverReject', () => {
  // escalationAction:'reject' is the default, so without this flag our own uncertainty becomes a
  // rejection telling the submitter their entry broke a rule.
  it.each([
    ['an unreadable response', {}],
    ['a refusal', { error: "I can't assist with that" }],
    [
      'an age-ambiguous subject in a suggestive context',
      { ...clean, minorUncertain: true, suggestiveStyling: true },
    ],
  ])('flags %s as never-reject', (_label, response) => {
    expect(decideFromObservations(response).neverReject).toBe(true);
  });

  it('does not flag a genuine content escalation as never-reject', () => {
    const result = decideFromObservations({ ...clean, suggestiveStyling: true });
    expect(result.decision).toBe('escalate');
    expect(result.neverReject).toBeFalsy();
  });
});
