import { describe, it, expect } from 'vitest';
import {
  buildCategoryReviewSchema,
  buildFallbackMessages,
  injectRubrics,
  RESPONSE_SCHEMA,
} from './generative-content';
import { getCategoryRubric } from './category-rubrics';
import { challengeJudgingCategoriesSchema } from '~/server/schema/challenge.schema';
import type { JudgingConfig } from './daily-challenge.utils';
import { stripLeadingWhitespace } from '~/utils/string-helpers';

// Prompts are written without leading whitespace so stripLeadingWhitespace() is a no-op and the
// expected strings below are the exact bytes prepareSystemMessage() emits.
function makeConfig(review: string): JudgingConfig {
  return {
    judgeId: 1,
    userId: 2,
    sourceCollectionId: null,
    reviewTemplate: null,
    prompts: {
      systemMessage: 'You are the judge.',
      collection: 'collection prompt',
      article: 'article prompt',
      content: 'content prompt',
      review,
      winner: 'winner prompt',
    },
  };
}

type ReviewCategory = { key: Parameters<typeof getCategoryRubric>[0]; name: string; criteria: string };

function makeInput(config: JudgingConfig, categories?: ReviewCategory[]) {
  return {
    theme: 'Space',
    creator: 'alice',
    imageUrl: 'https://example.com/img.png',
    config,
    categories,
    nsfw: false,
  };
}

function systemText(messages: ReturnType<typeof buildFallbackMessages>): string {
  const content = messages[0].content;
  if (typeof content === 'string') return content;
  const textItem = content.find((c) => c.type === 'text') as { type: 'text'; text: string };
  return textItem.text;
}

const CATS: ReviewCategory[] = [
  { key: 'theme', name: 'Theme', criteria: 'fits the theme' },
  { key: 'aesthetic', name: 'Aesthetic', criteria: 'looks good' },
];

describe('injectRubrics', () => {
  it('returns the prompt unchanged (referentially) when the sentinel is absent', () => {
    const prompt = 'Score the entry fairly and strictly.';
    expect(injectRubrics(prompt, CATS, false)).toBe(prompt);
  });

  it('replaces the sentinel with the joined rubric blocks when present', () => {
    const prompt = 'A {{SCORING_RUBRICS}} B';
    const out = injectRubrics(prompt, CATS, false);
    const block = [getCategoryRubric('theme'), getCategoryRubric('aesthetic')].join('\n\n');
    expect(out).toBe(`A ${block} B`);
    expect(out).not.toContain('{{SCORING_RUBRICS}}');
  });
});

describe('buildFallbackMessages — backward-compatibility invariant', () => {
  it('sentinel absent + categories present → injection is a no-op (review prompt appears raw)', () => {
    const review = 'Score the entry fairly and strictly.';
    const config = makeConfig(review);
    const messages = buildFallbackMessages(makeInput(config, CATS));
    const text = systemText(messages);

    // The review prompt appears verbatim (no rubric spliced in) — the invariant that matters when
    // the sentinel is absent. The category schema is used as-is (aestheticFlaws is an intentional
    // Task-3 addition, not part of the injection path).
    const expected = `${config.prompts.systemMessage}\n\n${stripLeadingWhitespace(
      review
    )}\n\nReply with json\n\n${stripLeadingWhitespace(buildCategoryReviewSchema(CATS))}`;
    expect(text).toBe(expected);
    expect(text).not.toContain('THEME SCORING');
    expect(text).not.toContain('AESTHETIC SCORING');
  });

  it('no categories (fixed daily path) → review prompt untouched, fixed schema, no rubric text', () => {
    const review = 'Score the entry fairly and strictly.';
    const config = makeConfig(review);
    const messages = buildFallbackMessages(makeInput(config, undefined));
    const text = systemText(messages);

    const expected = `${config.prompts.systemMessage}\n\n${stripLeadingWhitespace(
      review
    )}\n\nReply with json\n\n${stripLeadingWhitespace(RESPONSE_SCHEMA)}`;
    expect(text).toBe(expected);
  });
});

describe('buildFallbackMessages — rubric injection', () => {
  it('sentinel present + categories → rubric blocks injected, sentinel gone', () => {
    const review = 'Judge the image below.\n\n{{SCORING_RUBRICS}}\n\nBe strict.';
    const config = makeConfig(review);
    const messages = buildFallbackMessages(makeInput(config, CATS));
    const text = systemText(messages);

    expect(text).not.toContain('{{SCORING_RUBRICS}}');
    expect(text).toContain(getCategoryRubric('theme'));
    expect(text).toContain(getCategoryRubric('aesthetic'));

    const injected = `Judge the image below.\n\n${[
      getCategoryRubric('theme'),
      getCategoryRubric('aesthetic'),
    ].join('\n\n')}\n\nBe strict.`;
    const expected = `${config.prompts.systemMessage}\n\n${stripLeadingWhitespace(
      injected
    )}\n\nReply with json\n\n${stripLeadingWhitespace(buildCategoryReviewSchema(CATS))}`;
    expect(text).toBe(expected);
  });
});

describe('buildFallbackMessages — default-rubric fallback for the sentinel (Task 9)', () => {
  // A migrated judge prompt carries the sentinel, but a null/empty-category challenge (all current
  // daily/mod challenges) must still resolve it — to the canonical default blocks — while KEEPING the
  // fixed RESPONSE_SCHEMA (lowercase keys). It must NOT switch to the category schema.
  const DEFAULT_KEYS = ['theme', 'wittiness', 'humor', 'aesthetic'] as const;
  const defaultBlock = DEFAULT_KEYS.map((k) => getCategoryRubric(k)).join('\n\n');

  it.each<[string, ReviewCategory[] | undefined]>([
    ['null categories', undefined],
    ['empty categories', []],
  ])(
    'sentinel present + %s → default rubric blocks injected, fixed RESPONSE_SCHEMA, no unresolved sentinel',
    (_label, categories) => {
      const review = 'Judge the image below.\n\n{{SCORING_RUBRICS}}\n\nBe strict.';
      const config = makeConfig(review);
      const messages = buildFallbackMessages(makeInput(config, categories));
      const text = systemText(messages);

      // Sentinel fully resolved — the whole point of Task 9.
      expect(text).not.toContain('{{SCORING_RUBRICS}}');

      // The four canonical default rubric blocks are present.
      expect(text).toContain('THEME SCORING');
      expect(text).toContain('WITTINESS SCORING');
      expect(text).toContain('HUMOR SCORING');
      expect(text).toContain('AESTHETIC SCORING');

      // Injected prompt is byte-exact: sentinel → joined default blocks (theme/wittiness/humor/aesthetic).
      const injected = `Judge the image below.\n\n${defaultBlock}\n\nBe strict.`;
      expect(
        text.startsWith(
          `${config.prompts.systemMessage}\n\n${stripLeadingWhitespace(injected)}\n\nReply with json\n\n`
        )
      ).toBe(true);

      // Schema stays the FIXED RESPONSE_SCHEMA (lowercase keys) — NOT the category schema.
      expect(text).toContain('"theme": number');
      expect(text).toContain('"wittiness": number');
      expect(text).toContain('"humor": number');
      expect(text).toContain('"aesthetic": number');
    }
  );
});

describe('buildCategoryReviewSchema', () => {
  it('includes the optional aestheticFlaws field', () => {
    const schema = buildCategoryReviewSchema([{ name: 'Theme', criteria: 'fits' }]);
    expect(schema).toContain('"aestheticFlaws"');
  });

  it('still emits a score key per category', () => {
    const schema = buildCategoryReviewSchema([
      { name: 'Theme', criteria: 'fits' },
      { name: 'Aesthetic', criteria: 'looks good' },
    ]);
    expect(schema).toContain('"Theme": number');
    expect(schema).toContain('"Aesthetic": number');
  });
});

describe('caller mapping — parsed judging categories carry key', () => {
  it('maps ChallengeJudgingCategory → { key, name, criteria } that resolves a rubric', () => {
    const parsed = challengeJudgingCategoriesSchema.parse([
      { key: 'theme', weight: 60 },
      { key: 'aesthetic', weight: 40 },
    ]);
    // Mirror the caller in daily-challenge-processing.ts.
    const mapped = parsed.map((c) => ({ key: c.key, name: c.label, criteria: c.criteria }));
    expect(mapped.map((c) => c.key)).toEqual(['theme', 'aesthetic']);

    const messages = buildFallbackMessages(
      makeInput(makeConfig('Judge it.\n\n{{SCORING_RUBRICS}}'), mapped)
    );
    expect(systemText(messages)).toContain(getCategoryRubric('theme'));
  });
});
