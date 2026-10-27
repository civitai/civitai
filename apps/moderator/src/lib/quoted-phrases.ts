const MIN_PHRASE = 2;
// A quote that never closes would otherwise run on to the next quote mark and highlight the text between.
const MAX_PHRASE = 120;
const WORD = '\\p{L}\\p{N}';
// A quote opens after a non-word character and closes before one, so an apostrophe inside a word
// ("author's", "isn't") is not one.
const QUOTED = [
  `(?<![${WORD}])'([^'\\n]{1,${MAX_PHRASE}}?)'(?![${WORD}])`,
  `"([^"\\n]{1,${MAX_PHRASE}}?)"`,
  `“([^”\\n]{1,${MAX_PHRASE}}?)”`,
  `(?<![${WORD}])‘([^’\\n]{1,${MAX_PHRASE}}?)’(?![${WORD}])`,
];

/** Phrases a scan's reason quotes from the text it judged, to highlight there. */
export function quotedPhrases(reason: string): string[] {
  const found = new Set<string>();
  for (const source of QUOTED)
    for (const match of reason.matchAll(new RegExp(source, 'gu'))) {
      const phrase = match[1].trim();
      if (phrase.length >= MIN_PHRASE) found.add(phrase);
    }
  return [...found];
}
