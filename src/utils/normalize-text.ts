import { decode } from 'he';

// Static, deliberately. `he` was made a lazy `import()` in 4aede4ff99 to shrink the client
// bundle; the lazy form handed back an identity `decode` until it resolved, and every caller here
// reads the result synchronously, some of them twice either side of an `await`. So a decoder that
// is not available on the FIRST call is not an option, whatever replaces this one. If you came
// here to shrink the bundle again: `he` is ~98KB of source, nearly all entity table.
export function normalizeText(input?: string): string {
  if (!input) return '';
  let result = input;
  if (input.includes('&')) result = decode(input);
  return result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
