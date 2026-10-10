import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { cycleContaining, importCycles, importGraph, REPO_ROOT, rel } from './import-graph.harness';

/**
 * Caps the import cycles across the whole app, and only lets the caps go down. A module in a cycle
 * loads every other module in it, so a test that imports one pays for all of them, and an edit to
 * any of them re-runs every such test. no-image-service-import-cycle caps the biggest one; this
 * stops new ones forming anywhere.
 *
 * Two numbers, because each misses a shape the other sees: a new cycle, or a module joining one,
 * raises the module count; an edge that merges two cycles into one raises the largest.
 *
 * Only imports that load with the module count: a call-site `await import()` is how a cycle edge
 * is cut without moving code.
 */
const MAX_MODULES_IN_CYCLES = 53;
const MAX_LARGEST_CYCLE = 28;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') sources(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(rel(full));
    }
  }
  return out;
}

const graph = importGraph(sources(path.join(REPO_ROOT, 'src')), { followDynamic: false });
const cycles = importCycles(graph);
const modulesInCycles = cycles.reduce((n, c) => n + c.length, 0);
const largest = cycles[0]?.length ?? 0;

const listing = () =>
  cycles.map((c) => `  ${c.length} modules:\n    ${c.join('\n    ')}`).join('\n\n');

describe('import cycles across src/', () => {
  // Guards the guard: a resolver that stopped resolving `~/` would empty the graph, and an empty
  // graph has no cycles at all.
  it('walks a real graph', () => {
    expect(graph.size).toBeGreaterThan(5000);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('finds the same image.service cycle as the dedicated guard', () => {
    const image = 'src/server/services/image.service.ts';
    expect(cycles.find((c) => c.includes(image))).toEqual(cycleContaining(graph, image));
  });

  it(`keeps at most ${MAX_MODULES_IN_CYCLES} modules in cycles, the largest at most ${MAX_LARGEST_CYCLE}`, () => {
    if (modulesInCycles > MAX_MODULES_IN_CYCLES || largest > MAX_LARGEST_CYCLE) {
      throw new Error(
        `Import cycles grew: ${modulesInCycles} modules in cycles (cap ${MAX_MODULES_IN_CYCLES}), ` +
          `largest ${largest} (cap ${MAX_LARGEST_CYCLE}).\n` +
          `Find the import you added between two modules of one cycle below and make it a call-site ` +
          `\`await import()\`, or import the specific module instead of a barrel:\n\n` +
          listing()
      );
    }
  });

  it('has caps no looser than the cycles', () => {
    const file = __filename.split(/[\\/]/).pop();
    expect(modulesInCycles, `cycles shrank: lower MAX_MODULES_IN_CYCLES in ${file}`).toBe(
      MAX_MODULES_IN_CYCLES
    );
    expect(largest, `the largest cycle shrank: lower MAX_LARGEST_CYCLE in ${file}`).toBe(
      MAX_LARGEST_CYCLE
    );
  });
});
