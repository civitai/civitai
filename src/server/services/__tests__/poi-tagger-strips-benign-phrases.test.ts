import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Every POI check that WRITES A TAG must read the benign-stripped prompt.
 *
 * This exists because the fix for that bug was applied to one of two live copies. The image
 * scan pipeline has two implementations — `getTagsFromIncomingTags` in the webhook (legacy
 * `TagSource.WD14`/`Clavata`/`Hive` bodies) and `processTags` in the service (bodies carrying
 * `workflowId`, i.e. the orchestrator) — and the webhook dispatches between them by body
 * shape. Patching the one the audit named left the other writing a confidence-100 POI tag
 * from the raw prompt, which reaches the image search index. Behavioural tests did not catch
 * it because each drives one branch, and the untested branch was the live one.
 *
 * So this is a source-level guard, and it is deliberately about the SHAPE of the call rather
 * than its behaviour: a behavioural test proves the copy it drives, and the failure mode here
 * is the copy nobody drove.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const TAG_WRITING_SCAN_FILES = [
  'src/pages/api/webhooks/image-scan-result.ts',
  'src/server/services/image-scan-result.service.ts',
];

const POI_CALL = /includesPoi\(/g;
/** Enough of the call to see an inline `stripBenignPhrases(...)` wrapper. */
const CALL_WINDOW = 200;

function readSource(rel: string) {
  const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  // Fail closed: an empty or moved file must not read as "no offending call sites".
  expect(source.length, `${rel} is empty or unreadable`).toBeGreaterThan(1000);
  // Comments are stripped before scanning. They sit between the call and its argument, so a
  // few explanatory lines would otherwise push the real code out of the inspection window and
  // fail a call that is perfectly correct — and widening the window to compensate is what
  // would let it start seeing UNRELATED code further down and pass something unsafe.
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
}

describe('POI taggers read the benign-stripped prompt', () => {
  it('CONTROL: the matcher can actually see includesPoi calls in both files', () => {
    for (const rel of TAG_WRITING_SCAN_FILES) {
      const matches = [...readSource(rel).matchAll(POI_CALL)];
      expect(matches.length, `no includesPoi call found in ${rel}`).toBeGreaterThan(0);
    }
  });

  it.each(TAG_WRITING_SCAN_FILES)(
    'every includesPoi call in %s passes a stripped or already-audited prompt',
    (rel) => {
      const source = readSource(rel);

      for (const match of source.matchAll(POI_CALL)) {
        const window = source.slice(match.index, match.index + CALL_WINDOW);
        const call = window.split(/\r?\n/)[0].trim();

        // Two ways to be safe, and the identifier alone can decide neither: the audit
        // functions shadow `prompt` with the stripped copy, so the safe call and the unsafe
        // one are spelled identically.
        //   - the strip is inline in the call itself, or
        //   - the ENCLOSING function stripped before reaching it.
        const inlineStrip = window.includes('stripBenignPhrases');
        const declaration = source.lastIndexOf('function ', match.index);
        const strippedInScope = source
          .slice(declaration, match.index)
          .includes('stripBenignPhrases');

        expect(
          inlineStrip || strippedInScope,
          `${rel}: \`${call}\` reads a prompt nothing stripped. A POI hit here writes a ` +
            'confidence-100 tag that reaches the search index, so a moderator-whitelisted ' +
            'phrase would still flag the image.'
        ).toBe(true);
      }
    }
  );
});
