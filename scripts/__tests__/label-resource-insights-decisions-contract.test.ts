import { describe, expect, it } from 'vitest';

import {
  jevConfidenceFloor,
  scoreCriteriaCount,
  type JevAnswer,
  type JevQuestionSpec,
} from '~/server/services/ai/jev';
import {
  buildLabelQuestions,
  LABEL_BATCH_SIZE,
  LABEL_QUALITY_CRITERIA,
  LABEL_QUESTION_SPEC,
  parseLabelAnswers,
  type LabelableVersion,
} from '../label-resource-insights';

/**
 * What this pass owes the `/api/alpha/decisions` transport, in three parts.
 *
 * RUBRIC LENGTH. The wire carries only `criteria`; the vendor scores in index
 * space and is never told `min`/`max`, so the adapter maps back with
 * `score + min` and `askJev` refuses a request whose `criteria.length` does not
 * equal `max - min + 1`. A mismatch cannot fail quietly in the data — it
 * rescales every answer — so the count is pinned here against the spec's OWN
 * declared range rather than against a literal, and pinned again at the
 * per-resource rebuild, which is the second place it can drift.
 *
 * CONFIDENCE FLOOR. A row's confidence is the MINIMUM across its four
 * judgments, because the weakest one bounds what the row is worth. The fixtures
 * below give each answer a DIFFERENT confidence, with the minimum on an answer
 * that is not `role` — without that, a test cannot tell the floor apart from
 * the `role.confidence ?? 0` this code used to compute, which is precisely the
 * hole the existing fixtures left open (they passed under both).
 *
 * MEASURED SPEND. The run reports the vendor's own per-request `cost`, never a
 * token count multiplied by a price table. A batch that reports no cost is
 * counted separately rather than folded in as zero, so the printed total cannot
 * quietly understate the run.
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

/**
 * One resource's four answers, each with a DISTINCT confidence so the minimum
 * is identifiable and is NOT the one `role` carries.
 */
const answersWithConfidences = (
  index: number,
  { role = 0.9, styleFamily = 0.4, contentType = 0.7 }: Partial<Record<string, number>> = {}
): JevAnswer[] => [
  {
    id: `r${index}.role`,
    type: 'choice',
    value: 'style',
    distribution: { style: 1 },
    confidence: role,
  },
  {
    id: `r${index}.styleFamily`,
    type: 'choice',
    value: 'anime_manga',
    distribution: { anime_manga: 1 },
    confidence: styleFamily,
  },
  {
    id: `r${index}.contentType`,
    type: 'choice',
    value: 'portrait_character',
    distribution: { portrait_character: 1 },
    confidence: contentType,
  },
  { id: `r${index}.quality`, type: 'score', value: 7 },
];

describe('the quality rubric matches its declared range', () => {
  // Read through the DECLARED type, not the `as const` literal. `integer` is
  // optional on `JevScoreQuestion` and absent from the literal, so reading it
  // off the literal is a type error rather than the `undefined` the assertion
  // wants — and `pnpm typecheck` excludes this directory, so only
  // `node scripts/ci/typecheck-scripts-gate.mjs` reports that. This assignment
  // is a widening, not a cast: the spec already `satisfies` this type.
  const spec: readonly JevQuestionSpec[] = LABEL_QUESTION_SPEC;
  const quality = spec.find((q) => q.id === 'quality');

  it('supplies exactly one criterion per step of min..max inclusive', () => {
    // Derived from the spec's own range, so widening the range without
    // extending the rubric fails here rather than silently rescaling answers.
    expect(quality).toBeDefined();
    if (quality?.type !== 'score') throw new Error('the quality question must be a score question');
    // 🔴 Asserted on what the SPEC CARRIES, not on the exported constant. An
    // earlier revision of this test read `LABEL_QUALITY_CRITERIA.length`, which
    // is a different claim: slicing the rubric at the spec's own `criteria`
    // field left that assertion green because the constant was untouched, and
    // only the per-resource rebuild test noticed. The length that matters is
    // the one `askJev` will measure, which is this one.
    expect(quality.criteria).toHaveLength(quality.max - quality.min + 1);
    // And agrees with the counter `askJev`'s own guard uses.
    expect(scoreCriteriaCount(quality)).toBe(quality.max - quality.min + 1);
    // The constant and the spec field must also not have drifted apart.
    expect(quality.criteria).toEqual([...LABEL_QUALITY_CRITERIA]);
  });

  it('is a graded scale, not one point restated ten times', () => {
    expect(new Set(LABEL_QUALITY_CRITERIA).size).toBe(LABEL_QUALITY_CRITERIA.length);
    for (const criterion of LABEL_QUALITY_CRITERIA) {
      expect(criterion.length).toBeGreaterThan(20);
    }
  });

  it('does NOT round, because the score column is double precision', () => {
    if (quality?.type !== 'score') throw new Error('the quality question must be a score question');
    // `integer: true` would discard fractional precision the column can hold.
    expect(quality.integer).toBeUndefined();
  });

  it('keeps the rubric attached at the per-resource rebuild too', () => {
    const { questions } = buildLabelQuestions([version(1), version(2)]);
    const scores = questions.filter((q) => q.type === 'score');
    expect(scores).toHaveLength(2);
    for (const score of scores) {
      if (score.type !== 'score') throw new Error('filtered to score questions');
      expect(score.criteria).toEqual([...LABEL_QUALITY_CRITERIA]);
      expect(score.criteria).toHaveLength(score.max - score.min + 1);
      expect(score.integer).toBeUndefined();
    }
  });

  it('asks four questions per resource across a full batch', () => {
    const { questions } = buildLabelQuestions(
      Array.from({ length: LABEL_BATCH_SIZE }, (_, i) => version(i + 1))
    );
    expect(questions).toHaveLength(LABEL_BATCH_SIZE * 4);
  });
});

describe("a row's confidence is the floor across its own answers", () => {
  it('records the MINIMUM, not the role answer', () => {
    // role 0.9, styleFamily 0.4, contentType 0.7 -> floor 0.4.
    const { labels, failedVersionIds } = parseLabelAnswers(
      [version(11)],
      answersWithConfidences(0)
    );
    expect(failedVersionIds).toEqual([]);
    expect(labels).toHaveLength(1);
    expect(labels[0].confidence).toBeCloseTo(0.4);
  });

  it('takes the minimum wherever it sits, including on the role answer', () => {
    const { labels } = parseLabelAnswers(
      [version(11)],
      answersWithConfidences(0, { role: 0.2, styleFamily: 0.8, contentType: 0.6 })
    );
    expect(labels[0].confidence).toBeCloseTo(0.2);
  });

  it('is computed per resource, so one weak row cannot drag its neighbours', () => {
    const { labels } = parseLabelAnswers(
      [version(11), version(22)],
      [
        ...answersWithConfidences(0, { role: 0.9, styleFamily: 0.85, contentType: 0.95 }),
        ...answersWithConfidences(1, { role: 0.3, styleFamily: 0.35, contentType: 0.4 }),
      ]
    );
    expect(labels.map((l) => l.confidence)).toEqual([0.85, 0.3]);
  });

  it('declines a resource when no answer carried a confidence at all', () => {
    // `confidence` is optional on the wire, and the column is NOT NULL. There is
    // no honest number to record, so the resource fails and stays re-labelable.
    const answers = answersWithConfidences(0).map((answer) =>
      answer.type === 'noul' ? answer : ({ ...answer, confidence: undefined } as JevAnswer)
    );
    const { labels, failedVersionIds } = parseLabelAnswers([version(11)], answers);
    expect(labels).toEqual([]);
    expect(failedVersionIds).toEqual([11]);
  });

  describe('the helper contract this relies on', () => {
    it('EXCLUDES a noul answer rather than treating it as zero', () => {
      // A `?? 0` over a noul-containing set pins every floor to 0. The noul
      // variant carries no `confidence` field at all; this pins that the helper
      // skips it rather than defaulting it.
      const floor = jevConfidenceFloor([
        { id: 'needsResource', type: 'noul', value: 0.8 },
        { id: 'role', type: 'choice', value: 'style', distribution: { style: 1 }, confidence: 0.6 },
      ]);
      expect(floor).toBeCloseTo(0.6);
    });

    it('returns null when nothing in the set carries a confidence', () => {
      expect(jevConfidenceFloor([{ id: 'needsResource', type: 'noul', value: 0.8 }])).toBeNull();
    });
  });

  it('rejects a resource whose role answer arrives as a noul', () => {
    // The type guard must reject it, so a noul can never reach the floor from
    // this pass's own four questions.
    const answers = answersWithConfidences(0).filter((a) => a.id !== 'r0.role');
    const { labels, failedVersionIds } = parseLabelAnswers([version(11)], [
      { id: 'r0.role', type: 'noul', value: 0.5 },
      ...answers,
    ] as JevAnswer[]);
    expect(labels).toEqual([]);
    expect(failedVersionIds).toEqual([11]);
  });
});
