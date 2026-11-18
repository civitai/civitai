import { describe, expect, it } from 'vitest';
import { join } from 'path';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { scanSource } from '../../../../../test/source-scan';

/**
 * 🔴 SEAM GUARD: every producer of an App Block snapshot or workflow listing passes the
 * CALLING TOKEN's output ceiling.
 *
 * `snapshotFromWorkflow` and `projectAppWorkflow` are the only two places an output url
 * becomes something a block can read, and both take the ceiling as a REQUIRED argument
 * (`classifyBlockOutput` decides what is restricted with it). The type makes a call
 * without one fail to compile; it does not stop a call passing the WRONG one — an
 * all-levels constant would type-check and hand a restricted url to every app. So this
 * ledger names every production call site with the exact ceiling it passes, and FAILS
 * when the set GROWS (a new producer, whose ceiling nobody decided) or SHRINKS (a site
 * moved or was renamed, and the entry here went stale), or when a ceiling changes.
 *
 * Behaviour is pinned elsewhere: `block-output-restriction.test.ts` (the rule, per
 * producer function) and the router suites (each procedure, with a restricted
 * fixture). This pins the POPULATION.
 */

const ROOT = join(__dirname, '../../../../..');

const PRODUCERS = [
  'snapshotFromWorkflow',
  'projectAppWorkflow',
  'projectAppWorkflowWithPositions',
] as const;
const HOME = 'src/server/services/blocks/workflow.service.ts';

/** The token's ceiling, from the verified claims in scope at that site. */
const TOKEN = 'blockOutputCeilingFromClaims(claims)';
/** The token's ceiling plus the viewer's mint context: what an app-facing read passes. */
const VIEW = 'awaitresolveBlockOutputView(claims)';
/** The token's serving rules with no mint: a read that fetches the media server-side. */
const RULES = 'awaitresolveBlockOutputRules(claims)';
const RULES_NO_MINT = '{...(awaitresolveBlockOutputRules(claims)),mint:null}';
/** No outputs to judge (an estimate): the ceiling alone, serving off. */
const NO_OUTPUTS = '{...blockOutputCeilingFromClaims(claims),serving:false,mint:null}';

const LEDGER: Record<string, string> = {
  'src/server/routers/blocks.router.ts::pollWorkflow::snapshotFromWorkflow': VIEW,
  'src/server/routers/blocks.router.ts::cancelWorkflow::snapshotFromWorkflow': VIEW,
  'src/server/routers/blocks.router.ts::submitWorkflow::snapshotFromWorkflow': VIEW,
  'src/server/routers/blocks.router.ts::estimateBlockWorkflowCell::snapshotFromWorkflow':
    NO_OUTPUTS,
  'src/server/routers/blocks.router.ts::submitCustomComfyWorkflow::snapshotFromWorkflow': VIEW,
  'src/server/routers/blocks.router.ts::submitStepWorkflow::snapshotFromWorkflow': VIEW,
  'src/server/routers/blocks.router.ts::submitPassThroughStepWorkflow::snapshotFromWorkflow': VIEW,
  'src/server/routers/blocks.router.ts::submitMultiStepWorkflow::snapshotFromWorkflow': VIEW,
  'src/server/routers/blocks.router.ts::submitConfirmedQuoteWorkflow::snapshotFromWorkflow': VIEW,
  // `const outputView = await resolveBlockOutputView(claims)`, once for the page.
  'src/server/routers/blocks.router.ts::queryAppWorkflows::projectAppWorkflow': 'outputView',
  'src/server/routers/blocks.router.ts::cancelAppWorkflow::projectAppWorkflow': VIEW,
  'src/server/routers/blocks.router.ts::publishGenerationOutputs::projectAppWorkflowWithPositions':
    RULES_NO_MINT,
  'src/server/services/blocks/block-post.service.ts::resolveOwnedWorkflowOutputs::projectAppWorkflowWithPositions':
    '{...input.ceiling,mint:null}',
  'src/server/services/blocks/workflow.service.ts::projectAppWorkflow::projectAppWorkflowWithPositions':
    'view',
  // `outputAt` builds the view: the request's serving rules, minted only for what is shown.
  'src/server/services/blocks/block-output-unlock.service.ts::snapshotAt::snapshotFromWorkflow':
    'view',
  // Diagnostics only: the raw level at a position for the charged-but-not-released WARN; never
  // reaches the app.
  'src/server/services/blocks/block-output-unlock.service.ts::levelAt::projectAppWorkflowWithPositions':
    '{maxBrowsingLevel:allBrowsingLevelsFlag,serving:false,mint:null}',
  'src/server/services/app-assistant/app-activity.service.ts::generationOf::projectAppWorkflow':
    '{...blockOutputCeilingFromClaims({}),serving:false,mint:null}',
};

/**
 * The OBJECT-argument callers that carry a ceiling down to `resolveOwnedWorkflowOutputs`:
 * the `ceiling:` property each passes, by call site. Same grow-or-shrink rule.
 */
const OBJECT_CALLEES = ['resolveOwnedWorkflowOutputs', 'persistBlockGenerationSource'] as const;
const OBJECT_LEDGER: Record<string, string> = {
  'src/server/services/blocks/block-post.service.ts::resolveBlockPostSources::resolveOwnedWorkflowOutputs':
    'input.actor.outputCeiling',
  'src/server/services/blocks/block-generation-source.service.ts::persistWithin::resolveOwnedWorkflowOutputs':
    'input.ceiling',
  'src/server/routers/blocks.router.ts::persistGenerationSource::persistBlockGenerationSource':
    RULES,
};

/**
 * Every production `outputCeiling:` VALUE (the post actor's field, F5): the
 * `ceiling:`-property scan above cannot see it, because the property is spelled
 * differently and sits in an object literal rather than a call argument. A type
 * annotation (`outputCeiling: BlockOutputCeiling;`) is a declaration, not a value.
 */
const OUTPUT_CEILING_LEDGER: Record<string, string> = {
  'src/server/routers/blocks.router.ts::previewPostFromApp': RULES,
  'src/server/routers/blocks.router.ts::createPostFromApp': RULES,
};

function scanOutputCeilingValues() {
  const source = scanSource(ROOT);
  const found: Record<string, string> = {};
  for (const file of source.files) {
    const code = source.code.get(file)!;
    for (const m of code.matchAll(/\boutputCeiling\s*:\s*([^,\n}]+)/g)) {
      const value = m[1].replace(/\s+/g, '');
      if (/^[A-Z][\w.]*;?$/.test(value)) continue;
      const key = `${file}::${enclosing(code, m.index!)}`;
      if (key in found) throw new Error(`two outputCeiling values in one declaration: ${key}`);
      found[key] = value;
    }
  }
  return found;
}

/** The `ceiling:` property of the call opening at `open`, or null. */
function ceilingProperty(code: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        const m = /\bceiling:\s*([^,\n}]+)/.exec(code.slice(open, i));
        return m ? m[1].replace(/\s+/g, '') : null;
      }
    }
  }
  return null;
}

function scanObjectCallers() {
  const source = scanSource(ROOT);
  const found: Record<string, string | null> = {};
  for (const file of source.files) {
    const code = source.code.get(file)!;
    for (const name of OBJECT_CALLEES) {
      for (const m of code.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
        const at = m.index!;
        if (/function\s+$/.test(code.slice(Math.max(0, at - 40), at))) continue;
        const key = `${file}::${enclosing(code, at)}::${name}`;
        if (key in found) throw new Error(`two ${name} calls in one declaration: ${key}`);
        found[key] = ceilingProperty(code, at + m[0].length - 1);
      }
    }
  }
  return found;
}

const DECL = /^(?:export )?(?:async )?function (\w+)|^ {2}(\w+): \w*[pP]rocedure/gm;

function enclosing(code: string, offset: number): string {
  let name = '<module scope>';
  DECL.lastIndex = 0;
  for (;;) {
    const m = DECL.exec(code);
    if (!m || m.index >= offset) break;
    name = m[1] ?? m[2];
  }
  return name;
}

const normalise = (text: string) => text.replace(/\s+/g, '').replace(/,}/g, '}');

/** The text of the call's SECOND top-level argument, whitespace and trailing-comma normalised. */
function secondArgument(code: string, open: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = open + 1; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return start === -1 ? null : normalise(code.slice(start, i));
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      if (start !== -1) return normalise(code.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

function scan() {
  const source = scanSource(ROOT);
  const found: Record<string, string | null> = {};
  const bareReferences: string[] = [];
  for (const file of source.files) {
    const code = source.code.get(file)!;
    for (const name of PRODUCERS) {
      const re = new RegExp(`\\b${name}\\b`, 'g');
      for (const m of code.matchAll(re)) {
        const at = m.index!;
        const before = code.slice(Math.max(0, at - 40), at);
        const after = code.slice(at + name.length);
        // The definition, an import or re-export list entry, or a `typeof`.
        if (/function\s+$/.test(before) || /typeof\s+$/.test(before)) continue;
        if (
          /^\s*[,}]/.test(after) &&
          /(import|export)\s*(type\s*)?\{[^}]*$/.test(code.slice(Math.max(0, at - 4000), at))
        )
          continue;
        if (!/^\s*\(/.test(after)) {
          bareReferences.push(`${file}::${enclosing(code, at)}`);
          continue;
        }
        const open = at + name.length + after.indexOf('(');
        const key = `${file}::${enclosing(code, at)}::${name}`;
        if (key in found) throw new Error(`two ${name} calls in one declaration: ${key}`);
        found[key] = secondArgument(code, open);
      }
    }
  }
  return { found, bareReferences, home: source.code.get(HOME) };
}

describe('snapshot and listing producers — the ceiling each one passes', () => {
  const { found, bareReferences, home } = scan();

  it('POSITIVE CONTROL: the scan sees the producers and their definitions', () => {
    expect(home).toBeDefined();
    expect(home).toMatch(/export function snapshotFromWorkflow\(/);
    expect(home).toMatch(/export function projectAppWorkflow\(/);
    expect(Object.keys(found).length).toBeGreaterThanOrEqual(10);
  });

  it('the set of production call sites, and each ceiling, is exactly the ledger', () => {
    const normalisedLedger = Object.fromEntries(
      Object.entries(LEDGER).map(([k, v]) => [k, v.replace(/\s+/g, '')])
    );
    expect(found).toStrictEqual(normalisedLedger);
  });

  it('every caller that resolves an output position passes the token ceiling', () => {
    const objectCallers = scanObjectCallers();
    // POSITIVE CONTROL: the scan found the callers at all.
    expect(Object.keys(objectCallers).length).toBeGreaterThanOrEqual(3);
    expect(objectCallers).toStrictEqual(
      Object.fromEntries(Object.entries(OBJECT_LEDGER).map(([k, v]) => [k, v.replace(/\s+/g, '')]))
    );
  });

  it('F5: the post actor outputCeiling is the token ceiling at every site', () => {
    const values = scanOutputCeilingValues();
    // POSITIVE CONTROL: both actor sites were found.
    expect(Object.keys(values).length).toBeGreaterThanOrEqual(2);
    expect(values).toStrictEqual(
      Object.fromEntries(
        Object.entries(OUTPUT_CEILING_LEDGER).map(([k, v]) => [k, v.replace(/\s+/g, '')])
      )
    );
  });

  it('no producer is passed around as a bare value (e.g. `.map(projectAppWorkflow)`)', () => {
    // A bare reference loses the ceiling argument at the type level only if the callee
    // checks it; `Array.map` passes the INDEX as the second argument.
    expect(bareReferences).toStrictEqual([]);
  });
});
