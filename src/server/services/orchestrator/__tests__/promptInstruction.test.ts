import { describe, expect, it } from 'vitest';
import { buildInstruction } from '~/server/services/orchestrator/promptInstruction';

type Input = Parameters<typeof buildInstruction>[0];

const build = (overrides: Partial<Input> = {}) =>
  buildInstruction({ prompt: 'a cat on a windowsill', ...overrides } as Input);

describe('buildInstruction — formatting', () => {
  it('asks for multi-line output when the prompt is a single line', () => {
    const out = build();
    expect(out).toContain('Format the enhanced prompt across multiple lines');
    expect(out).toContain('Do not return it as a single unbroken line');
  });

  it('preserves the user’s own line structure instead of imposing a default', () => {
    const out = build({ prompt: 'a cat\non a windowsill\ngolden hour' });
    expect(out).toContain('Preserve that line structure');
    expect(out).toContain('Do not collapse it onto one line');
    expect(out).not.toContain('Format the enhanced prompt across multiple lines');
  });

  it('lets an explicit segment request override both defaults', () => {
    const out = build({ prompt: 'a cat\non a windowsill', segmentPrompt: true });
    expect(out).toContain('thematic segments');
    expect(out).not.toContain('Preserve that line structure');
  });

  it('always emits exactly one formatting directive', () => {
    const directives = [
      'thematic segments',
      'Preserve that line structure',
      'Format the enhanced prompt across multiple lines',
    ];
    for (const input of [
      {},
      { prompt: 'a\nb' },
      { segmentPrompt: true },
      { prompt: 'a\nb', segmentPrompt: true },
    ] as Partial<Input>[]) {
      const out = build(input);
      expect(directives.filter((d) => out.includes(d))).toHaveLength(1);
    }
  });
});

describe('buildInstruction — singleTake', () => {
  it('says nothing when unset, so image requests carry no shot directive', () => {
    const out = build();
    expect(out).not.toContain('continuous take');
    expect(out).not.toContain('Multiple shots');
  });

  it('emits a directive for each state rather than only the true case', () => {
    expect(build({ singleTake: true })).toContain('Describe a single continuous take');
    expect(build({ singleTake: false })).toContain('Multiple shots with cuts');
  });
});

describe('buildInstruction — preservation directives', () => {
  it('only names trigger words that actually appear, and says which field', () => {
    const out = build({
      prompt: 'ohwx man in a field',
      negativePrompt: 'blurry, badhands',
      preserveTriggerWords: ['ohwx', 'badhands', 'unused'],
    });
    expect(out).toContain('trigger words in the prompt: ohwx');
    expect(out).toContain('trigger words in the negative prompt: badhands');
    expect(out).not.toContain('unused');
  });

  it('asks snippet references to hold position, unlike trigger words', () => {
    const out = build({ prompt: '#character in a field', preserveSnippets: ['character'] });
    expect(out).toContain('#character');
    expect(out).toContain('approximately the same position');
  });

  it('unions preserveSnippets with snippetTargets and dedupes case-insensitively', () => {
    const out = build({
      prompt: '#character and #Style',
      preserveSnippets: ['character', '#CHARACTER'],
      snippetTargets: { prompt: [{ category: 'Style' }] as never },
    });
    const refs = out.match(/#character|#CHARACTER|#Style/gi) ?? [];
    expect(new Set(refs.map((r) => r.toLowerCase()))).toEqual(new Set(['#character', '#style']));
  });
});

describe('buildInstruction — length budget', () => {
  it('states a word budget, since characters are not countable by the model', () => {
    const out = build();
    expect(out).toMatch(/under about \d+ words/);
    expect(out).not.toContain('characters');
  });

  it('covers the negative prompt only when one was supplied', () => {
    expect(build({ negativePrompt: 'blurry' })).toContain('and the enhanced negative prompt');
    expect(build()).not.toContain('and the enhanced negative prompt');
  });
});

describe('buildInstruction — user instruction', () => {
  it('passes the user’s own instruction through verbatim', () => {
    const out = build({ instruction: 'make it feel like a Wes Anderson film' });
    expect(out).toContain('make it feel like a Wes Anderson film');
  });
});
