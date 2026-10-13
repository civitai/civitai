import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { cycleContaining, importCycles, importGraph, REPO_ROOT, rel } from './import-graph.harness';

/**
 * Ratchet: caps the modules in import cycles across src/, and the cycles' weight (the sum of each
 * cycle's size squared). Neither may rise. A new cycle or a module joining one raises both; an edge
 * merging two cycles raises only the weight. Cutting one cycle while adding another of the same
 * size passes: a count cannot see membership.
 */
const MAX_MODULES_IN_CYCLES = 53;
const MAX_CYCLE_WEIGHT = 867;

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

// Static imports only: a call-site `await import()` is how a cycle edge is cut.
const graph = importGraph(sources(path.join(REPO_ROOT, 'src')), { followDynamic: false });
const cycles = importCycles(graph);
const modulesInCycles = cycles.reduce((n, c) => n + c.length, 0);
const weight = cycles.reduce((n, c) => n + c.length ** 2, 0);

const listing = () =>
  cycles.map((c) => `  ${c.length} modules:\n    ${c.join('\n    ')}`).join('\n\n');

describe('import cycles across src/', () => {
  // A resolver that stopped resolving `~/` would empty the graph, and an empty graph has no cycles.
  it('walks a real graph', () => {
    expect(graph.size).toBeGreaterThan(5000);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it('finds the same image.service cycle as the dedicated guard', () => {
    const image = 'src/server/services/image.service.ts';
    expect(cycles.find((c) => c.includes(image))).toEqual(cycleContaining(graph, image));
  });

  it(`keeps at most ${MAX_MODULES_IN_CYCLES} modules in cycles, weight at most ${MAX_CYCLE_WEIGHT}`, () => {
    if (modulesInCycles > MAX_MODULES_IN_CYCLES || weight > MAX_CYCLE_WEIGHT) {
      throw new Error(
        `Import cycles grew: ${modulesInCycles} modules in cycles (cap ${MAX_MODULES_IN_CYCLES}), ` +
          `weight ${weight} (cap ${MAX_CYCLE_WEIGHT}).\n` +
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
    expect(weight, `cycles shrank: lower MAX_CYCLE_WEIGHT in ${file}`).toBe(MAX_CYCLE_WEIGHT);
  });
});
