import { describe, it, expect } from 'vitest';
import {
  buildModelModerationText,
  isModelTextNsfw,
  MODEL_MODERATION_SCAN_LABELS,
} from '~/server/services/model-moderation.adapter';

describe('buildModelModerationText', () => {
  it('joins name and tag-stripped description', () => {
    expect(
      buildModelModerationText({ name: 'My LoRA', description: '<p>A <b>style</b> model</p>' })
    ).toBe('My LoRA A style model');
  });

  it('omits a missing description rather than emitting a trailing space', () => {
    expect(buildModelModerationText({ name: 'My LoRA', description: null })).toBe('My LoRA');
  });

  it('collapses whitespace so two equivalent descriptions hash identically', () => {
    const a = buildModelModerationText({ name: 'X', description: '<p>a</p>\n<p>b</p>' });
    const b = buildModelModerationText({ name: 'X', description: '<p>a</p>    <p>b</p>' });
    expect(a).toBe(b);
  });
});

describe('isModelTextNsfw', () => {
  it.each(['NSFW', 'Suggestive', 'Explicit', 'nsfw', 'suggestive', 'explicit'])(
    'triggers on the level label %s regardless of case',
    (label) => {
      expect(isModelTextNsfw({ triggeredLabels: [label] })).toBe(true);
    }
  );

  // The submit sends 15 labels; only 3 may act. A Review/Block label triggering must not
  // flip nsfw — that is the difference between this and honouring `output.blocked`.
  it.each(['Young', 'Grooming', 'Sex Trafficking', 'Bestiality', 'Celebrity', 'Scat'])(
    'does NOT trigger on the non-level label %s',
    (label) => {
      expect(isModelTextNsfw({ triggeredLabels: [label] })).toBe(false);
    }
  );

  it('is false when nothing triggered', () => {
    expect(isModelTextNsfw({ triggeredLabels: [] })).toBe(false);
    expect(isModelTextNsfw({})).toBe(false);
  });
});

describe('MODEL_MODERATION_SCAN_LABELS', () => {
  it('covers all fifteen registry labels', () => {
    expect(MODEL_MODERATION_SCAN_LABELS).toHaveLength(15);
  });
});
