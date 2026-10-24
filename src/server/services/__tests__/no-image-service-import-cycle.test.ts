import { describe, expect, it } from 'vitest';

import { cycleContaining, importGraph } from './import-graph.harness';

/**
 * image.service sits in an import cycle with the user, post, collection and buzz services and the
 * search-index barrel. Every module in the cycle loads the whole cycle and everything it imports,
 * so a test that imports any of them pays for ~800 modules, and an edit to any of them re-runs
 * every such test. This caps the cycle and only lets the cap go down.
 *
 * Only imports that load with the module count: a call-site `await import()` is how a cycle edge
 * is cut without moving code.
 */
const MAX_CYCLE = 28;

const IMAGE_SERVICE = 'src/server/services/image.service.ts';
const graph = importGraph([IMAGE_SERVICE], { followDynamic: false });
const cycle = cycleContaining(graph, IMAGE_SERVICE);

describe('the image.service import cycle', () => {
  // Guards the guard: a resolver that stopped resolving `~/` would empty the graph, and an empty
  // cycle passes any cap.
  it('walks a real graph', () => {
    expect(graph.size).toBeGreaterThan(500);
    expect(cycle).toContain('src/server/services/user.service.ts');
  });

  it(`stays at or under ${MAX_CYCLE} modules`, () => {
    if (cycle.length > MAX_CYCLE) {
      throw new Error(
        `The import cycle containing ${IMAGE_SERVICE} grew to ${cycle.length} modules (cap ${MAX_CYCLE}).\n` +
          `Find the import you added between two of these and make it a call-site \`await import()\`,\n` +
          `or import the specific module instead of a barrel:\n\n  ` +
          cycle.join('\n  ')
      );
    }
  });

  it('has a cap no looser than the cycle', () => {
    expect(
      cycle.length,
      `the cycle shrank to ${cycle.length}: lower MAX_CYCLE in ${__filename.split(/[\\/]/).pop()}`
    ).toBe(MAX_CYCLE);
  });
});
