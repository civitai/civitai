import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: vi.fn(),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn(),
}));

import { checkInlineComfyGraph } from '~/server/services/blocks/inline-comfy.service';
import { getRecipe, REGISTERED_RECIPE_IDS } from '~/server/services/blocks/recipes';

/**
 * `checkInlineComfyGraph` (civitai-app-starters#774): the one place an inline
 * `customComfy` graph is checked for runnability before any spend. The refusal
 * cases are proved through the router and the REST routes
 * (`blocks.router.workflow.test.ts`, `workflows-controls-seam.test.ts`); this file
 * pins the two things those cannot:
 *
 *   1. the platform's own graphs pass, so the check cannot refuse the shape the
 *      server itself sends (models named by AIR, core nodes);
 *   2. WHO runs it: the set of call sites is exact, so a new path that accepts an
 *      inline graph without the check, or a removed call, goes red here.
 */

describe('the platform recipes build graphs the runnability check accepts', () => {
  const cases = REGISTERED_RECIPE_IDS.flatMap((id) => {
    const recipe = getRecipe(id)!;
    return recipe.engines.map((engine) => ({ id, engine, recipe }));
  });

  // Positive control on the population: the starter recipe the spike ran end to
  // end must be in it, or "every recipe passes" could pass over an empty list.
  it('covers starter-comfy-txt2img', () => {
    expect(cases.map((c) => c.id)).toContain('starter-comfy-txt2img');
  });

  it.each(cases)(
    '$id ($engine) is runnable, and the checked graph is the graph',
    ({ engine, recipe }) => {
      const params = recipe.paramSchema.parse({
        prompt: 'a lighthouse at dusk',
        ...(recipe.engines.length > 1 ? { engine } : {}),
      });
      const { workflow } = recipe.buildStep(params, {});
      const verdict = checkInlineComfyGraph(workflow);
      expect(verdict).toEqual({ runnable: true, graph: workflow });
    }
  );

  // Negative control on the same fixture: the starter graph with one AIR swapped
  // for a filename is refused, so the case above is not passing a check that
  // refuses nothing.
  it('the starter graph with its unet named by filename is refused with model-filenames', () => {
    const recipe = getRecipe('starter-comfy-txt2img')!;
    const { workflow } = recipe.buildStep(recipe.paramSchema.parse({ prompt: 'x' }), {});
    const loaderId = Object.keys(workflow).find((k) => workflow[k].class_type === 'UNETLoader')!;
    const broken = {
      ...workflow,
      [loaderId]: {
        ...workflow[loaderId],
        inputs: { ...workflow[loaderId].inputs, unet_name: 'z_image_turbo_bf16.safetensors' },
      },
    };
    const verdict = checkInlineComfyGraph(broken);
    expect(verdict.runnable).toBe(false);
    expect(!verdict.runnable && verdict.snapshot.errorCode).toBe('model-filenames');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CALLER LEDGER. Every non-test call of `checkInlineComfyGraph`, by
// `<file>:<enclosing function>`, compared EXACTLY: it fails when a caller is
// added, removed or moved. Any other use of the name (passed as a value, an
// aliased import) is reported as UNREADABLE rather than scored as no call.
// ─────────────────────────────────────────────────────────────────────────────

const LEDGER = [
  'src/server/routers/blocks.router.ts:estimateCustomComfyWorkflow',
  'src/server/routers/blocks.router.ts:submitCustomComfyWorkflow',
];

const CHECK = 'checkInlineComfyGraph';
const DEFINING_FILE = 'src/server/services/blocks/inline-comfy.service.ts';
/** The router's narrowing to the inline arm: every function that does it must run the check. */
const NARROW = 'isInlineComfyBody';

const repoRoot = path.resolve(__dirname, '../../../../..');

function isTestPath(rel: string) {
  return rel.includes('/__tests__/') || rel.startsWith('src/tests/') || /\.test\.tsx?$/.test(rel);
}

function walk(dir: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
}

function enclosingFunctionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      return n.name.getText();
    }
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent)
    ) {
      return n.parent.name.getText();
    }
  }
  return '<module>';
}

type Scan = { calls: string[]; unreadable: string[]; filesWithName: string[] };

function scan(name: string): Scan {
  const files: string[] = [];
  walk(path.join(repoRoot, 'src'), files);
  const calls: string[] = [];
  const unreadable: string[] = [];
  const filesWithName: string[] = [];
  for (const full of files) {
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    if (isTestPath(rel)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (!text.includes(name)) continue;
    filesWithName.push(rel);
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === name) {
        const parent = node.parent;
        const isDeclarationName =
          (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
          parent.name === node;
        const isPlainImport =
          ts.isImportSpecifier(parent) && !parent.propertyName && parent.name === node;
        if (ts.isCallExpression(parent) && parent.expression === node) {
          calls.push(`${rel}:${enclosingFunctionName(node)}`);
        } else if (!isDeclarationName && !isPlainImport) {
          unreadable.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { calls: [...new Set(calls)].sort(), unreadable, filesWithName };
}

describe('checkInlineComfyGraph caller ledger', () => {
  const result = scan(CHECK);

  it('the scan reads the defining file (positive control: it can see the name at all)', () => {
    expect(result.filesWithName).toContain(DEFINING_FILE);
  });

  it('every use of the name is a readable direct call', () => {
    expect(result.unreadable).toEqual([]);
  });

  it('the callers are exactly the inline estimate and the inline submit', () => {
    expect(result.calls).toEqual([...LEDGER].sort());
  });

  // The seam: the ledger above is only complete if no OTHER function narrows a
  // body to the inline arm. Every function that calls the router's inline
  // narrowing must also be a caller of the check.
  it('every function that narrows a body to the inline arm also runs the check', () => {
    const narrowing = scan(NARROW);
    expect(narrowing.calls.length).toBeGreaterThan(0);
    expect(narrowing.unreadable).toEqual([]);
    for (const site of narrowing.calls) expect(LEDGER).toContain(site);
  });
});
