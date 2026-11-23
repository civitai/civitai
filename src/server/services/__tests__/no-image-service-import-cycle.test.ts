import { describe, expect, it } from 'vitest';

import { cycleContaining, importGraph } from './import-graph.harness';

/**
 * Every module in image.service's import cycle reaches the whole cycle, so every page and API route
 * that touches one pulls all of it into its graph. This caps the cycle and only lets the cap go down.
 * Dynamic `import()` counts; docs/dev/import-cycles.md says how to break an edge.
 */
const MAX_CYCLE = 188;

const IMAGE_SERVICE = 'src/server/services/image.service.ts';
const graph = importGraph([IMAGE_SERVICE]);
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
          `Find the import you added between two of these and break it as docs/dev/import-cycles.md\n` +
          `describes (an \`await import()\` does not count as a cut):\n\n  ` +
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
