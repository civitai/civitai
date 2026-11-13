import { describe, expect, it } from 'vitest';
import { mulberry32 } from '~/server/services/resource-intent-cooc/build';
import {
  coocCoreName,
  coocOwnModelTokens,
  coocPromptTokens,
  coocQueryTokens,
  coocTrainingTokens,
  COOC_MIN_TOKEN_CHARS,
  COOC_STOPWORDS,
  normalizeCoocText,
} from '~/server/services/resource-intent-cooc/tokenize';

/**
 * Seam: the shipped tokeniser against the offline screen's own functions. The ORACLE block below is
 * the screen's source copied verbatim (only reformatted by prettier); it is the definition the index
 * was measured with, so it must never be edited to make this test pass.
 */
// ---------------------------------- ORACLE (screen source) ----------------------------------
function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
const VERSION_TOKEN = /^(v|ver|version)?\d+([._]\d+)*[a-z]?$/;
const TYPE_WORDS = new Set([
  'lora',
  'lycoris',
  'locon',
  'loha',
  'lokr',
  'dora',
  'embedding',
  'ti',
  'textual',
  'inversion',
  'sd',
  'sd1',
  'sd15',
  'sdxl',
  'xl',
  'pony',
  'illustrious',
  'il',
  'noobai',
  'noob',
  'flux',
  'safetensors',
  'pt',
  'ckpt',
]);
function coreName(name: string): string {
  const unbracketed = name.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|【[^】]*】|（[^）]*）/g, ' ');
  return norm(unbracketed)
    .split(' ')
    .filter((t) => t && !VERSION_TOKEN.test(t) && !TYPE_WORDS.has(t))
    .join(' ');
}
const R2_MIN_TOKEN_CHARS = 3;
const R2_STOPWORDS = new Set([
  'the',
  'and',
  'with',
  'for',
  'from',
  'her',
  'his',
  'its',
  'are',
  'was',
  'were',
  'this',
  'that',
  'these',
  'those',
  'into',
  'onto',
  'very',
  'has',
  'have',
  'had',
  'she',
  'him',
  'they',
  'them',
  'their',
  'there',
  'then',
  'than',
  'while',
  'which',
  'who',
  'whom',
  'what',
  'when',
  'where',
  'not',
  'but',
  'all',
  'any',
  'out',
  'off',
  'over',
  'under',
  'can',
  'will',
  'just',
  'also',
  'each',
  'both',
  'some',
  'such',
  'only',
  'own',
  'same',
  'too',
  'our',
  'your',
  'you',
]);
function r2Tokens(prompt: string): string[] {
  const stripped = prompt
    .replace(/<[^>]*>/g, ' ')
    .replace(/\bembedding:[^\s,()\[\]{}]+/gi, ' ')
    .replace(/:\s*-?\d+(?:\.\d+)?/g, ' ')
    .replace(/\bBREAK\b/g, ' ');
  return norm(stripped)
    .split(' ')
    .filter((t) => t.length >= R2_MIN_TOKEN_CHARS && !/^\d+$/.test(t) && !R2_STOPWORDS.has(t));
}
function ownModelTokens(
  models: { modelName: string; trainedWords: string[] | null }[]
): Set<string> {
  const s = new Set<string>();
  for (const a of models) {
    for (const t of norm(a.modelName).split(' ')) if (t) s.add(t);
    for (const t of coreName(a.modelName).split(' ')) if (t) s.add(t);
    for (const w of (a.trainedWords ?? []).flatMap((x) => x.split(',')))
      for (const t of norm(w).split(' ')) if (t) s.add(t);
  }
  return s;
}
// -------------------------------------- END ORACLE --------------------------------------------

/** The screen's own fixtures (its `tokenFixtures`), plus edge strings. Synthetic text only. */
const SCREEN_FIXTURES = [
  '(masterpiece:1.2), <lora:Foo_Bar:0.8> <lyco:Baz:1> 1girl, BREAK embedding:EasyNeg zzqx',
  'gzmwndr pose, wonder city, shiny armor, gizmo, style, lora',
  'the and with, 12345, ab',
];
const EDGE = [
  '',
  '   ',
  'Café Ｆｕｌｌｗｉｄｔｈ naïve Ångström ﬁsh',
  '(word:1.2) (other: -0.5) [x:3] {y:0.25}',
  'BREAKING BREAK break xBREAK',
  'Embedding:Foo,embedding:bar(baz) EMBEDDING:qux',
  '<a<b>c> <unclosed tag',
  '日本語の テスト 漢字 😀 emoji',
  'v2 version3 ver1.5a sd15 sdxl lora LoRA',
  '【tag】 （wide） (paren) [square] {curly}',
  'ab abc abcd 123 1234a a1b2',
];
const NAMES = [
  'Gizmo Wonder Style v2 LoRA',
  'Café (Anime) [SDXL] {v1.5} 【JP】 （wide）',
  'version3 ti pony',
  '',
  'Ｆｕｌｌ Ｗｉｄｔｈ ﬁ',
];

const POOL = [
  '<lora:Foo_Bar:0.8>',
  '<lyco:X:1>',
  '(masterpiece:1.2)',
  'BREAK',
  'embedding:EasyNeg',
  'café',
  'Ｆｕｌｌｗｉｄｔｈ',
  '1girl',
  'the',
  '12345',
  'ab',
  'v2.1',
  'LoRA',
  '【tag】',
  '(x)',
  '[y]',
  '{z}',
  ',',
  ' ',
  '—',
  'naïve',
  'Ångström',
  '日本語',
  '😀',
  'x:-0.5',
  'sdxl',
  'Version3',
  'ﬁsh',
  'é',
  ':',
  '<',
  '>',
  'cyberpunk',
  'neon',
  'with',
  'TOKEN',
  'tok00123',
  ' ',
  '\t',
  'ǅ',
  'İstanbul',
];
function randomStrings(seed: number, n: number) {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const parts: string[] = [];
    const k = Math.floor(rand() * 14);
    for (let i = 0; i < k; i++) {
      if (rand() < 0.75) parts.push(POOL[Math.floor(rand() * POOL.length)]);
      else parts.push(String.fromCodePoint(0x20 + Math.floor(rand() * 0x2fe0)));
      if (rand() < 0.5) parts.push(rand() < 0.5 ? ' ' : ', ');
    }
    return parts.join('');
  });
}

const PROMPTS = [...SCREEN_FIXTURES, ...EDGE, ...randomStrings(20261008, 3000)];
const MODEL_TEXTS = [
  [{ modelName: 'Gizmo Wonder Style v2 LoRA', trainedWords: ['gzmwndr pose, shiny'] }],
  [{ modelName: NAMES[1], trainedWords: null }],
  NAMES.map((modelName, i) => ({ modelName, trainedWords: i % 2 ? ['a,b', 'neon city'] : [] })),
  ...randomStrings(7, 300).map((s, i) => [
    { modelName: s, trainedWords: i % 3 ? randomStrings(i, 2) : null },
  ]),
];

describe('cooc tokeniser seam: shipped == screen', () => {
  it('constants match the screen', () => {
    expect(COOC_MIN_TOKEN_CHARS).toBe(R2_MIN_TOKEN_CHARS);
    expect([...COOC_STOPWORDS].sort()).toEqual([...R2_STOPWORDS].sort());
  });

  it(`norm and coreName agree on ${PROMPTS.length + NAMES.length} strings`, () => {
    for (const s of [...PROMPTS, ...NAMES]) {
      expect(normalizeCoocText(s), s).toBe(norm(s));
      expect(coocCoreName(s), s).toBe(coreName(s));
    }
  });

  it('prompt tokens (ordered, with repeats) and query tokens (deduped) agree', () => {
    let nonEmpty = 0;
    for (const p of PROMPTS) {
      const want = r2Tokens(p);
      if (want.length) nonEmpty++;
      expect(coocPromptTokens(p), p).toEqual(want);
      expect(coocQueryTokens(p), p).toEqual([...new Set(want)]);
    }
    // Positive control: the random strings must actually produce tokens to compare.
    expect(nonEmpty).toBeGreaterThan(1000);
  });

  it('own-model tokens and training tokens agree (the screen draw: q minus own)', () => {
    let removedSomething = 0;
    for (const models of MODEL_TEXTS) {
      expect([...coocOwnModelTokens(models)].sort()).toEqual([...ownModelTokens(models)].sort());
      for (const p of PROMPTS.slice(0, 400)) {
        const own = ownModelTokens(models);
        const q = [...new Set(r2Tokens(p))];
        const want = q.filter((x) => !own.has(x));
        if (want.length < q.length) removedSomething++;
        expect(coocTrainingTokens(p, models)).toEqual(want);
      }
    }
    expect(removedSomething).toBeGreaterThan(0);
  });

  it("the screen's fixture assertions hold on the shipped functions", () => {
    expect(coocPromptTokens(SCREEN_FIXTURES[0]).join(' ')).toBe('masterpiece 1girl zzqx');
    expect(
      coocTrainingTokens(SCREEN_FIXTURES[1], [
        { modelName: 'Gizmo Wonder Style v2 LoRA', trainedWords: ['gzmwndr pose, shiny'] },
      ]).join(' ')
    ).toBe('city armor');
    expect(coocPromptTokens(SCREEN_FIXTURES[2])).toEqual([]);
  });
});
