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
 *
 * TWO LIMITS, stated because a guard whose edges are undocumented gets read as covering more
 * than it does:
 *
 * 1. The enclosing-scope check walks back to the nearest `function ` keyword, so it does not
 *    understand an arrow function or a class method — one of those would inherit the previous
 *    declaration's strip and pass. Both taggers are `function` declarations today; a new one
 *    written as an arrow needs the strip INLINE at the call to be checked properly.
 * 2. Scope is the two files that WRITE A TAG from a POI hit, which is this guard's title. Two
 *    other server-side `includesPoi` calls read a raw prompt and are deliberately NOT covered,
 *    because neither writes a tag:
 *      - `services/apps/shared-content-safety.ts` — throws `SharedContentBlockedError('poi')`,
 *        so a whitelisted proper noun hard-refuses the content rather than mislabelling it.
 *      - `services/orchestrator/orchestration-new.service.ts` — a second POI decision on the
 *        generation path, beside the `auditPromptServer` one that does strip.
 *    Both are real gaps in the whitelist's reach, and both are follow-up work rather than
 *    oversights — they are named here so the two-file list does not read as settled.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const TAG_WRITING_SCAN_FILES = [
  'src/pages/api/webhooks/image-scan-result.ts',
  'src/server/services/image-scan-result.service.ts',
];

const POI_CALL = /includesPoi\(/g;

/**
 * The argument list of one `includesPoi(` call — paren-balanced, so it ends at that call's own
 * closing paren. A fixed-size forward window was tried and is wrong: it reads past the end of
 * the call, so an unrelated `stripBenignPhrases` on the NEXT statement satisfies it, and both
 * of these files contain several. Balancing means only this call's own argument counts.
 */
function callArguments(source: string, start: number) {
  let depth = 0;
  for (let i = source.indexOf('(', start); i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

function readSource(rel: string) {
  const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  // Fail closed: an empty or moved file must not read as "no offending call sites".
  expect(source.length, `${rel} is empty or unreadable`).toBeGreaterThan(1000);
  // Comments are stripped before scanning, and the reason is NOT the one this used to give:
  // the fixed inspection window that comments could push code out of is gone, replaced by
  // paren-balancing. The reason now is the scope check — a comment MENTIONING
  // `stripBenignPhrases` anywhere between a function's declaration and the call would
  // otherwise satisfy `strippedInScope` and pass a call that strips nothing.
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
        const argumentList = callArguments(source, match.index);
        const call = argumentList.split(/\r?\n/)[0].trim();

        // Two ways to be safe, and the identifier alone can decide neither: the audit
        // functions shadow `prompt` with the stripped copy, so the safe call and the unsafe
        // one are spelled identically.
        //   - the strip is inline in the call itself, or
        //   - the ENCLOSING function stripped before reaching it.
        const inlineStrip = argumentList.includes('stripBenignPhrases');
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
