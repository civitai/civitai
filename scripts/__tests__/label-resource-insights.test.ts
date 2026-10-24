import { describe, expect, it } from 'vitest';

import {
  buildLabelQuestions,
  isLabelStale,
  LABEL_BATCH_SIZE,
  LABEL_QUESTION_SPEC,
  LABEL_SPEC_HASH,
  parseLabelAnswers,
  partitionNeedingLabel,
  type LabelableVersion,
} from '../label-resource-insights';

/**
 * Fixture-based tests for the labeling pass. No Jev call, no DB — the batch
 * question builder and the answer parser are pure, so every scenario below is a
 * literal fixture and every expectation a literal value.
 */

const version = (id: number, overrides: Partial<LabelableVersion> = {}): LabelableVersion => ({
  id,
  // Deliberately a DIFFERENT id space from the version id: a fixture where
  // the two coincide cannot tell a model-id enqueue from a version-id one.
  modelId: 9000 + id,
  name: `Version ${id}`,
  baseModel: 'SDXL 1.0',
  trainedWords: ['trigger'],
  description: 'A test resource',
  model: { type: 'LORA', nsfw: false },
  ...overrides,
});

const answer = (
  id: string,
  rest: Record<string, unknown>
): Record<string, unknown> & { id: string } => ({ id, ...rest });

const validAnswers = (count: number) =>
  Array.from({ length: count }, (_, i) => [
    answer(`r${i}.role`, {
      type: 'choice',
      value: 'style',
      distribution: { style: 0.9, none: 0.1 },
      confidence: 0.8,
    }),
    answer(`r${i}.styleFamily`, {
      type: 'choice',
      value: 'anime_manga',
      distribution: { anime_manga: 1 },
    }),
    answer(`r${i}.contentType`, {
      type: 'choice',
      value: 'portrait_character',
      distribution: { portrait_character: 1 },
    }),
    answer(`r${i}.quality`, { type: 'score', value: 7 }),
  ]).flat();

describe('LABEL_QUESTION_SPEC', () => {
  it('carries four questions per resource with stable ids', () => {
    expect(LABEL_QUESTION_SPEC.map((q) => q.id)).toEqual([
      'role',
      'styleFamily',
      'contentType',
      'quality',
    ]);
  });

  it('hashes deterministically', () => {
    expect(LABEL_SPEC_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildLabelQuestions', () => {
  it('emits LABEL_BATCH_SIZE x 4 namespaced questions for a full batch', () => {
    const { questions } = buildLabelQuestions(
      Array.from({ length: LABEL_BATCH_SIZE }, (_, i) => version(i + 1))
    );
    expect(questions).toHaveLength(LABEL_BATCH_SIZE * 4);
    expect(questions[0].id).toBe('r0.role');
    expect(questions.at(-1)?.id).toBe(`r${LABEL_BATCH_SIZE - 1}.quality`);
  });

  it('namespaces state per resource with only that resource’s metadata', () => {
    const { state } = buildLabelQuestions([
      version(1, { name: 'Alpha', description: 'Long '.repeat(200) }),
    ]);
    expect(Object.keys(state)).toEqual(['resource0']);
    const parsed = JSON.parse(state.resource0) as Record<string, unknown>;
    // 🔴 The EXACT key set, not `toMatchObject`. The fetched row now carries
    // `modelId`, which exists only so a written label can be announced to the
    // models index and is explicitly not a judgment input — and `toMatchObject`
    // ignores extra keys, so it would pass while the vendor request quietly
    // gained a field. Pinning the keys is what makes that claim testable.
    expect(Object.keys(parsed).sort()).toEqual([
      'baseModel',
      'description',
      'name',
      'trainedWords',
      'type',
    ]);
    expect(parsed).toMatchObject({ name: 'Alpha', type: 'LORA', baseModel: 'SDXL 1.0' });
    // Description truncated to the cap, so one noisy resource cannot dominate the request.
    expect((parsed.description as string).length).toBeLessThanOrEqual(300);
  });
});

describe('parseLabelAnswers', () => {
  it('maps a full valid batch to labels with pinned values', () => {
    const versions = [version(11), version(22)];
    const { labels, failedVersionIds } = parseLabelAnswers(
      versions,
      validAnswers(2) as never as Parameters<typeof parseLabelAnswers>[1]
    );
    expect(failedVersionIds).toEqual([]);
    expect(labels).toEqual([
      {
        modelVersionId: 11,
        role: 'style',
        styleFamily: 'anime_manga',
        contentTypes: ['portrait_character'],
        qualityScore: 0.7,
        confidence: 0.8,
        specHash: LABEL_SPEC_HASH,
        model: 'typesafe/jev-1.13',
      },
      {
        modelVersionId: 22,
        role: 'style',
        styleFamily: 'anime_manga',
        contentTypes: ['portrait_character'],
        qualityScore: 0.7,
        confidence: 0.8,
        specHash: LABEL_SPEC_HASH,
        model: 'typesafe/jev-1.13',
      },
    ]);
  });

  it('skips one malformed resource without poisoning its batch neighbors', () => {
    const versions = [version(11), version(22), version(33)];
    const answers = validAnswers(3);
    // Resource 1's quality answer is missing entirely.
    const filtered = answers.filter((a) => a.id !== 'r1.quality');
    const { labels, failedVersionIds } = parseLabelAnswers(
      versions,
      filtered as never as Parameters<typeof parseLabelAnswers>[1]
    );
    expect(labels.map((l) => l.modelVersionId)).toEqual([11, 33]);
    expect(failedVersionIds).toEqual([22]);
  });

  it('skips a resource whose answers arrive under wrong types', () => {
    const versions = [version(11), version(22)];
    const answers = [
      // Resource 0's role answer arrives as a noul — wrong shape for the question.
      answer('r0.role', { type: 'noul', value: 0.5 }),
      answer('r0.styleFamily', { type: 'choice', value: 'anime_manga', distribution: {} }),
      answer('r0.contentType', { type: 'choice', value: 'other', distribution: {} }),
      answer('r0.quality', { type: 'score', value: 5 }),
      // Resource 1's full set, ids shifted to r1.
      ...validAnswers(1).map((a) => ({ ...a, id: a.id.replace('r0.', 'r1.') })),
    ];
    const { labels, failedVersionIds } = parseLabelAnswers(
      versions,
      answers as never as Parameters<typeof parseLabelAnswers>[1]
    );
    expect(labels.map((l) => l.modelVersionId)).toEqual([22]);
    expect(failedVersionIds).toEqual([11]);
  });
});

describe('isLabelStale', () => {
  it('a row is never stale against its own spec hash', () => {
    expect(isLabelStale({ specHash: LABEL_SPEC_HASH, stale: false }, LABEL_SPEC_HASH)).toBe(false);
  });

  it('a row under a different spec hash is stale', () => {
    expect(isLabelStale({ specHash: 'a'.repeat(64), stale: false }, LABEL_SPEC_HASH)).toBe(true);
  });

  it('an already-stale row stays stale even under the current hash', () => {
    expect(isLabelStale({ specHash: LABEL_SPEC_HASH, stale: true }, LABEL_SPEC_HASH)).toBe(true);
  });

  it('no existing row means nothing to re-label', () => {
    expect(isLabelStale(null, LABEL_SPEC_HASH)).toBe(false);
  });
});

describe('partitionNeedingLabel', () => {
  const versions = [version(1), version(2), version(3)];

  it('labels unlabeled and stale rows, skips current ones', () => {
    const existing = [
      { modelVersionId: 2, specHash: LABEL_SPEC_HASH, stale: false },
      { modelVersionId: 3, specHash: 'b'.repeat(64), stale: false },
    ];
    const { toLabel, skipped } = partitionNeedingLabel(versions, existing, LABEL_SPEC_HASH);
    expect(toLabel.map((v) => v.id)).toEqual([1, 3]);
    expect(skipped).toBe(1);
  });

  it('an already-stale row is re-labeled even under the current hash', () => {
    const existing = [{ modelVersionId: 1, specHash: LABEL_SPEC_HASH, stale: true }];
    const { toLabel, skipped } = partitionNeedingLabel(versions, existing, LABEL_SPEC_HASH);
    expect(toLabel.map((v) => v.id)).toEqual([1, 2, 3]);
    expect(skipped).toBe(0);
  });

  it('everything current means an empty batch', () => {
    const existing = versions.map((v) => ({
      modelVersionId: v.id,
      specHash: LABEL_SPEC_HASH,
      stale: false,
    }));
    const { toLabel, skipped } = partitionNeedingLabel(versions, existing, LABEL_SPEC_HASH);
    expect(toLabel).toEqual([]);
    expect(skipped).toBe(3);
  });
});
