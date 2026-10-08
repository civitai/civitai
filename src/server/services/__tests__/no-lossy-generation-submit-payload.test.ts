import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Keys the generation footer's submit payload must carry, pinned textually because dropping one is
 * silent: the footer never sent `sourceProvenance`, so the server-minted remix token — the thing
 * that gates the free remix-gallery submission and the `derivedFromHost` badge — was dropped on
 * every generate while the UNVERIFIED `remixOfId` beside it went through. The form generates fine
 * either way; the loss surfaces only when someone asks why a remix isn't credited (868m5acdq).
 *
 * It parses the top-level keys of `generateMutation.mutateAsync({...})`, so it checks presence and
 * nothing about the values. The anchors exist because the failure mode of a parser like this is an
 * EMPTY set, which satisfies every `arrayContaining` below — they are what fails instead.
 */

const repoRoot = path.resolve(__dirname, '../../../..');

const FOOTER = 'src/components/form-graph/generation/FormFooter.tsx';

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
          // is the key: dropping `...boostFields` is how the paid boost goes missing.
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

const source = readFileSync(path.join(repoRoot, FOOTER), 'utf8');
const payload = submitPayloadKeys(source);

describe('the generation footer submits every key the server needs', () => {
  it('POSITIVE CONTROL — the footer parses to a real payload, not an empty set', () => {
    expect(
      payload,
      `Parsed no keys out of ${FOOTER}. The submit call was renamed or reshaped, so ` +
        `every assertion below is matching an empty set — fix this parser first.`
    ).toEqual(expect.arrayContaining([...ANCHORS]));
  });

  it('the footer still sends the remix source AND its provenance token', () => {
    expect(
      payload,
      `${FOOTER} dropped one of the remix keys. \`sourceProvenance\` is the only VERIFIED ` +
        `half — losing it while keeping \`remixOfId\` leaves the footer asserting a derivation it ` +
        `can no longer prove.`
    ).toEqual(expect.arrayContaining([...REMIX_KEYS]));
  });

  it('the footer still spreads the download-boost fields', () => {
    expect(
      payload,
      `${FOOTER} stopped spreading \`boostFields\`. The footer then never sends ` +
        `\`downloadPriority\`, so a user who turned the boost on — or chose Boost in the mobile ` +
        `confirm — is charged nothing and silently gets the free lane.`
    ).toContain('boostFields');
  });

  /**
   * The keys above say nothing about the VALUE, and this one is a money gate: the
   * prompt token is spendable only against the image the remix claim names, and
   * the store enforces that by taking the id. A footer reverting to the no-argument
   * call would still submit a `sourceProvenance` key, so the key assertions above stay
   * green while the footer spends a token minted from an unrelated click.
   */
  it('the footer reads the prompt token against the claim it is submitting under', () => {
    expect(source).toMatch(/getPromptToken\(remixOfId\)/);
    expect(source).not.toMatch(/getPromptToken\(\s*\)/);
  });
});
