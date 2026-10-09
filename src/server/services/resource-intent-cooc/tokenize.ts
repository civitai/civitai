/**
 * The co-occurrence index's tokeniser, ported from the offline screen that measured it. Training
 * and query tokens must come out of these exact rules or the counts stop meaning what was measured;
 * `src/server/services/__tests__/resource-intent-cooc.tokenize.seam.test.ts` compares every
 * function here with the screen's own source.
 *
 * 🔴 KEEP THIS MODULE A LEAF (no imports): the request path will load it, and must not pull in the
 * builder or the DB graph with it.
 */

/** NFKD, strip combining marks, lowercase, every run of non-letter/non-digit → one space. */
export function normalizeCoocText(s: string): string {
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

/** Model name minus bracketed segments, version tokens and type/base-model words. */
export function coocCoreName(name: string): string {
  const unbracketed = name.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|【[^】]*】|（[^）]*）/g, ' ');
  return normalizeCoocText(unbracketed)
    .split(' ')
    .filter((t) => t && !VERSION_TOKEN.test(t) && !TYPE_WORDS.has(t))
    .join(' ');
}

export const COOC_MIN_TOKEN_CHARS = 3;
export const COOC_STOPWORDS: ReadonlySet<string> = new Set([
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

/** Prompt tokens before deduplication: syntax stripped, normalised, short/numeric/stopword dropped. */
export function coocPromptTokens(prompt: string): string[] {
  const stripped = prompt
    .replace(/<[^>]*>/g, ' ')
    .replace(/\bembedding:[^\s,()\[\]{}]+/gi, ' ')
    .replace(/:\s*-?\d+(?:\.\d+)?/g, ' ')
    .replace(/\bBREAK\b/g, ' ');
  return normalizeCoocText(stripped)
    .split(' ')
    .filter((t) => t.length >= COOC_MIN_TOKEN_CHARS && !/^\d+$/.test(t) && !COOC_STOPWORDS.has(t));
}

/** A query's tokens: the prompt tokens, deduplicated, nothing removed. */
export function coocQueryTokens(prompt: string): string[] {
  return [...new Set(coocPromptTokens(prompt))];
}

export type CoocModelText = { modelName: string; trainedWords: string[] | null };

/**
 * TRAINING ONLY: every token of the image's own attached models' full names, core names and trigger
 * words. Removing them stops the index learning trigger→model from the image that used it.
 */
export function coocOwnModelTokens(models: readonly CoocModelText[]): Set<string> {
  const s = new Set<string>();
  for (const a of models) {
    for (const t of normalizeCoocText(a.modelName).split(' ')) if (t) s.add(t);
    for (const t of coocCoreName(a.modelName).split(' ')) if (t) s.add(t);
    for (const w of (a.trainedWords ?? []).flatMap((x) => x.split(',')))
      for (const t of normalizeCoocText(w).split(' ')) if (t) s.add(t);
  }
  return s;
}

/** A training image's tokens: the query tokens minus its own models' tokens. */
export function coocTrainingTokens(prompt: string, ownModels: readonly CoocModelText[]): string[] {
  const own = coocOwnModelTokens(ownModels);
  return coocQueryTokens(prompt).filter((t) => !own.has(t));
}
