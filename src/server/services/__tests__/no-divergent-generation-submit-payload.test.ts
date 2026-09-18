import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The form-graph generator is meant to submit exactly what the data-graph one submits. Nothing
 * enforced that, and the two drifted: the form-graph footer never sent `sourceProvenance`, so on
 * that lane the server-minted remix token — the thing that gates the free remix-gallery submission
 * and the `derivedFromHost` badge — was dropped on every generate, while the UNVERIFIED `remixOfId`
 * beside it went through. Nobody would see it: both lanes generate fine, the loss is invisible until
 * someone asks why a remix on one lane isn't credited (868m5acdq).
 *
 * This guard compares the top-level keys of each footer's `generateMutation.mutateAsync({...})`
 * payload. It is textual, so it checks the one property text can check: that a key added to one
 * footer is added to the other. It says NOTHING about the values being equivalent.
 *
 * The anchors below exist because the failure mode of a parser like this is two EMPTY sets, which
 * compare equal. Rename `generateMutation` in both files and the key comparison passes happily —
 * the anchor assertions are what fail instead.
 */

const repoRoot = path.resolve(__dirname, '../../../..');

const FOOTERS = {
  'data-graph': 'src/components/generation_v2/FormFooter.tsx',
  'form-graph': 'src/components/form-graph/generation/FormFooter.tsx',
} as const;

/**
 * Structural keys, used only to prove the parser found a real payload. Deliberately NOT the remix
 * keys — those are pinned separately below, so that a genuine removal reads as a removal rather
 * than as a broken parser.
 */
const ANCHORS = ['input', 'creatorTip', 'externalId'] as const;

/** The pair this guard was written for: one unverified claim, one server-minted proof. */
const REMIX_KEYS = ['remixOfId', 'sourceProvenance'] as const;

/**
 * Top-level keys of the object literal passed to `generateMutation.mutateAsync(...)`.
 * Handles both plain entries (`remixOfId,` / `tags: [...]`) and the conditional spreads the
 * optional ones use (`...(sourceMetadata ? { sourceMetadata } : {})`).
 */
function submitPayloadKeys(source: string): string[] {
  const start = source.indexOf('generateMutation.mutateAsync({');
  if (start === -1) return [];

  let depth = 0;
  let end = -1;
  const open = source.indexOf('{', start);
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];

  const keys: string[] = [];
  let lineDepth = 0;
  for (const line of source.slice(open + 1, end).split('\n')) {
    if (lineDepth === 0) {
      const plain = /^\s*(\w+)\s*[:,]/.exec(line);
      if (plain) keys.push(plain[1]);
      else {
        const spread = /^\s*\.\.\..*\{\s*(\w+)[\s,}]/.exec(line);
        if (spread) keys.push(spread[1]);
        else {
          // A bare `...ident,` spread carries keys this parser cannot see, so the identifier itself
          // is the key: dropping `...boostFields` from one lane is how the paid boost goes missing.
          const bare = /^\s*\.\.\.(\w+),?\s*$/.exec(line);
          if (bare) keys.push(bare[1]);
        }
      }
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') lineDepth++;
      else if (ch === '}' || ch === ')' || ch === ']') lineDepth--;
    }
  }
  return Array.from(new Set(keys)).sort();
}

const payloads = Object.fromEntries(
  Object.entries(FOOTERS).map(([lane, rel]) => [
    lane,
    submitPayloadKeys(readFileSync(path.join(repoRoot, rel), 'utf8')),
  ])
) as Record<keyof typeof FOOTERS, string[]>;

describe('both generation footers submit the same payload shape', () => {
  it.each(Object.keys(FOOTERS) as (keyof typeof FOOTERS)[])(
    'POSITIVE CONTROL — the %s footer parses to a real payload, not an empty set',
    (lane) => {
      expect(
        payloads[lane],
        `Parsed no keys out of ${FOOTERS[lane]}. The submit call was renamed or reshaped, so ` +
          `the parity assertion below is comparing nothing to nothing — fix this parser first.`
      ).toEqual(expect.arrayContaining([...ANCHORS]));
    }
  );

  it.each(Object.keys(FOOTERS) as (keyof typeof FOOTERS)[])(
    'the %s footer still sends the remix source AND its provenance token',
    (lane) => {
      expect(
        payloads[lane],
        `${FOOTERS[lane]} dropped one of the remix keys. \`sourceProvenance\` is the only VERIFIED ` +
          `half — losing it while keeping \`remixOfId\` leaves the lane asserting a derivation it ` +
          `can no longer prove.`
      ).toEqual(expect.arrayContaining([...REMIX_KEYS]));
    }
  );

  it.each(Object.keys(FOOTERS) as (keyof typeof FOOTERS)[])(
    'the %s footer still spreads the download-boost fields',
    (lane) => {
      expect(
        payloads[lane],
        `${FOOTERS[lane]} stopped spreading \`boostFields\`. That lane then never sends ` +
          `\`downloadPriority\`, so a user who turned the boost on — or chose Boost in the mobile ` +
          `confirm — is charged nothing and silently gets the free lane.`
      ).toContain('boostFields');
    }
  );

  it('neither footer carries a key the other does not', () => {
    const [a, b] = Object.keys(FOOTERS) as (keyof typeof FOOTERS)[];
    expect(
      payloads[b],
      `The two generation footers must submit the same keys — the form-graph lane is a port of the ` +
        `data-graph one, not a variant of it. Missing from ${b}: ` +
        `[${payloads[a].filter((k) => !payloads[b].includes(k))}]. ` +
        `Extra in ${b}: [${payloads[b].filter((k) => !payloads[a].includes(k))}]. ` +
        `Add the key to both, or state here why one lane legitimately differs.`
    ).toEqual(payloads[a]);
  });
});
