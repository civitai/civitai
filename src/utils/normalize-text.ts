import { decode } from 'he';

// Static, not a lazy `import('he')`. The lazy form handed back an identity `decode` until the
// dynamic import resolved, so the first input containing an entity was normalized without being
// decoded, and two callers normalizing the same input either side of an `await` could then see
// two different results. Keep the decode synchronous on the first call. `he` is ~98KB of source,
// nearly all entity table, so if it has to leave the client bundle the replacement still has to
// decode on the first call rather than warm up.
export function normalizeText(input?: string): string {
  if (!input) return '';
  let result = input;
  if (input.includes('&')) result = decode(input);
  return result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
