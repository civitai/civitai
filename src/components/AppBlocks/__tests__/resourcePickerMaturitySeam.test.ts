import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { PAGE_RESOURCE_PICKER_TYPES } from '../pageBlockHostLogic';

/**
 * SEAM guard for the page resource picker's TYPE allowlist vs the shared
 * ResourceSelectModal's MATURITY filtering.
 *
 * Widening `PAGE_RESOURCE_PICKER_TYPES` changes WHICH resource types an App
 * Block may ask the host to open a picker for. It must not change WHAT MATURITY
 * a viewer can be shown. Those two live in different files owned by different
 * features, which is exactly the shape a per-component test cannot see: the host
 * suite proves the host passes no maturity option, the modal suite proves the
 * modal filters correctly, and neither notices if the host GAINS a maturity
 * lever or the modal LOSES its ceiling.
 *
 * So this pins the RELATIONSHIP, as an asserted ledger that fails when either
 * side's set GROWS or SHRINKS:
 *
 *   1. `ResourceSelectOptions` — the ONLY thing the host can hand the shared
 *      modal — declares no maturity/browsing/sfwOnly control at all. If one is
 *      ever added, this goes red and the host's picker call site must be
 *      re-reviewed before the option can silently become reachable from a block.
 *   2. `ResourceHitList` — where the shared modal actually filters — calls
 *      `useApplyHiddenPreferences` with NO `browsingLevel` override, so it falls
 *      through to the site-wide `useBrowsingLevelDebounced()` ceiling. A
 *      `browsingLevel` argued in there would let this surface diverge from the
 *      site-wide ceiling, in either direction.
 *
 * These are structural claims about source text, which is what a cross-file
 * ledger can assert cheaply. The BEHAVIOURAL half — that the host in fact passes
 * the same maturity-free options bag for every allowlisted type — is asserted in
 * PageBlockHostResourcePicker.browser.test.tsx against the real component.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const OPTIONS_FILE = 'src/components/ImageGeneration/GenerationForm/resource-select.types.ts';
const HIT_LIST_FILE =
  'src/components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceHitList.tsx';

/** Field names declared at the TOP level of a `type X = { … }` declaration. */
function topLevelFieldNames(source: string, typeName: string): string[] {
  const start = source.indexOf(`export type ${typeName} = {`);
  expect(start, `${typeName} declaration not found`).toBeGreaterThanOrEqual(0);
  let i = source.indexOf('{', start);
  let depth = 0;
  const fields: string[] = [];
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    // A top-level field starts at a line beginning (after whitespace).
    const m = /^\s*\n\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(source.slice(i - 1, i + 40));
    if (m) fields.push(m[1]);
  }
  return [...new Set(fields)].sort();
}

/** Argument keys of the first `fn({ … })` object-literal call in `source`. */
function objectArgKeys(source: string, fn: string): string[] {
  const start = source.indexOf(`${fn}({`);
  expect(start, `${fn}({…}) call not found`).toBeGreaterThanOrEqual(0);
  let i = source.indexOf('{', start);
  let depth = 0;
  const keys: string[] = [];
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += ch === '{' ? 1 : 0;
      if (ch !== '{') continue;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    const m = /^[\s,{]\s*([A-Za-z_$][\w$]*)\s*:/.exec(source.slice(i - 1, i + 40));
    if (m) keys.push(m[1]);
  }
  return [...new Set(keys)].sort();
}

describe('page resource picker ⇄ shared modal maturity seam', () => {
  it('the allowlist is Checkpoint + the LoRA family (the set this seam is asserted for)', () => {
    expect([...PAGE_RESOURCE_PICKER_TYPES].sort()).toEqual(['Checkpoint', 'DoRA', 'LORA', 'LoCon']);
  });

  it('ResourceSelectOptions exposes NO maturity/browsing/sfwOnly control', () => {
    // Exact ledger, not a "does not contain" check: a NEW option is a change to
    // what the host could pass, and must be reviewed at this seam either way.
    expect(topLevelFieldNames(read(OPTIONS_FILE), 'ResourceSelectOptions')).toEqual([
      'canGenerate',
      'excludeIds',
      'resources',
    ]);
  });

  it('ResourceHitList applies hidden preferences with NO browsingLevel override', () => {
    // No override ⇒ useApplyHiddenPreferences falls through to the site-wide
    // useBrowsingLevelDebounced() ceiling, which is the guarantee the picker
    // inherits and which widening the TYPE allowlist must not disturb.
    expect(objectArgKeys(read(HIT_LIST_FILE), 'useApplyHiddenPreferences')).toEqual([
      'data',
      'type',
    ]);
  });
});
