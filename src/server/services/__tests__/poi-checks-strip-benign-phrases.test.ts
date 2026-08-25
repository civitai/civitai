import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Every server-side POI check that ACTS ON A USER — writing a tag, or refusing a request —
 * must read the benign-stripped prompt.
 *
 * This exists because the fix for that bug was applied to one of two live copies. The image
 * scan pipeline has two implementations — `getTagsFromIncomingTags` in the webhook (legacy
 * `TagSource.WD14`/`Clavata`/`Hive` bodies) and `processTags` in the service (bodies carrying
 * `workflowId`, i.e. the orchestrator) — and the webhook dispatches between them by body
 * shape. Patching the one the audit named left the other writing a confidence-100 POI tag
 * from the raw prompt, which reaches the image search index. Behavioural tests did not catch
 * it because each drives one branch, and the untested branch was the live one.
 *
 * The same thing then happened a third time, one layer away: the generation path's own POI
 * decision in `createWorkflowStepsFromGraph` still read the raw prompt, so a phrase a
 * moderator had whitelisted refused the generation outright for any viewer with `disablePoi`.
 * That is why this guard's scope is "acts on a user" rather than "writes a tag" — the
 * narrower title is what let the third site read as out of scope.
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
 *    declaration's strip and pass. Every guarded call sits in a `function` declaration today;
 *    a new one written as an arrow needs the strip INLINE at the call to be checked properly.
 *    The escape also weakens as the enclosing function grows, since ANY `stripBenignPhrases`
 *    between the declaration and the call satisfies it. An entry whose call strips inline
 *    should therefore set `requireInline` and give up the escape entirely — only the two scan
 *    files need it, because they shadow `prompt` with the stripped copy further up.
 * 2. One other server-side `includesPoi` call reads a raw prompt and is deliberately NOT
 *    covered: `services/apps/shared-content-safety.ts` throws `SharedContentBlockedError('poi')`
 *    on shared app content, which is a hard legal reject rather than a moderation label.
 *    Whether a moderator whitelist may suppress a legal reject is a product decision that has
 *    not been taken — `includesMinor(combined)` on the line above raises the same question one
 *    notch higher. It is named here so the file list does not read as settled; do not add it
 *    without that decision.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Each entry names what a POI hit in that file DOES to a user, because that consequence is
 * the whole argument for the file being here — and it is what the failure message has to say
 * to whoever trips this guard.
 */
const GUARDED_FILES: { rel: string; consequence: string; requireInline?: boolean }[] = [
  {
    rel: 'src/pages/api/webhooks/image-scan-result.ts',
    consequence:
      'writes a confidence-100 POI tag that reaches the image search index, so a ' +
      'moderator-whitelisted phrase would still flag the image',
  },
  {
    rel: 'src/server/services/image-scan-result.service.ts',
    consequence:
      'writes a confidence-100 POI tag that reaches the image search index, so a ' +
      'moderator-whitelisted phrase would still flag the image',
  },
  {
    rel: 'src/server/services/orchestrator/orchestration-new.service.ts',
    // The enclosing function is ~300 lines, so the scope escape below would be satisfied by ANY
    // later `stripBenignPhrases` in it — negative-prompt stripping being the obvious one, since
    // both scan files pair it with the prompt strip. This call needs no escape, so it gets none.
    requireInline: true,
    consequence:
      'refuses the generation outright for a viewer with `disablePoi`, so a ' +
      'moderator-whitelisted phrase would still throw a real-person error at the creator',
  },
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

describe('server-side POI checks read the benign-stripped prompt', () => {
  it('CONTROL: the matcher can actually see includesPoi calls in every guarded file', () => {
    for (const { rel } of GUARDED_FILES) {
      const matches = [...readSource(rel).matchAll(POI_CALL)];
      expect(matches.length, `no includesPoi call found in ${rel}`).toBeGreaterThan(0);
    }
  });

  it.each(GUARDED_FILES.map((f) => [f.rel, f.consequence, !!f.requireInline] as const))(
    'every includesPoi call in %s passes a stripped or already-audited prompt',
    (rel, consequence, requireInline) => {
      const source = readSource(rel);

      for (const match of source.matchAll(POI_CALL)) {
        const argumentList = callArguments(source, match.index);
        const call = argumentList.split(/\r?\n/)[0].trim();

        // Two ways to be safe, and the identifier alone can decide neither: the audit
        // functions shadow `prompt` with the stripped copy, so the safe call and the unsafe
        // one are spelled identically.
        //   - the strip is inline in the call itself, or
        //   - the ENCLOSING function stripped before reaching it.
        // `requireInline` entries must also NORMALIZE before stripping. The guard covered
        // "was it stripped" and nothing covered "was it stripped in the right alphabet" —
        // `stripBenignPhrases(prompt, …)` without `normalizeText` passes typecheck and reopens
        // the hazard `shared/utils/benign-phrases.ts` marks load-bearing.
        const inlineStrip =
          argumentList.includes('stripBenignPhrases') &&
          (!requireInline || argumentList.includes('normalizeText'));
        const declaration = source.lastIndexOf('function ', match.index);
        const strippedInScope =
          !requireInline && source.slice(declaration, match.index).includes('stripBenignPhrases');

        expect(
          inlineStrip || strippedInScope,
          `${rel}: \`${call}\` reads a prompt nothing stripped${
            requireInline ? ', or stripped before it was normalized' : ''
          }. A POI hit here ${consequence}.`
        ).toBe(true);
      }
    }
  );
});
