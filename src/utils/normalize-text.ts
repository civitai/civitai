import { decode } from 'he';
import { foldDiacritics } from '~/utils/fold-diacritics';

// `he` is static, deliberately. It was made a lazy `import()` in 4aede4ff99 to shrink the client
// bundle; the lazy form handed back an identity `decode` until it resolved, and every caller here
// reads the result synchronously, some of them twice either side of an `await`. So a decoder that
// is not available on the FIRST call is not an option, whatever replaces this one.
//
// Entity decoding is only meaningful for text that can arrive escaped, which in practice means
// generation prompts. If you are adding a caller that only ever handles display strings, take
// `foldDiacritics` directly rather than widening this one: importing this module costs the chunk
// ~98KB of source, nearly all of it `he`'s entity table.
export function normalizeText(input?: string): string {
  if (!input) return '';
  return foldDiacritics(input.includes('&') ? decode(input) : input);
}
