import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DataGraph } from './data-graph';

// External-context reactivity: nodes opt into ext changes via `ext:<key>` deps.
// `setExt` seeds `ext:<key>` tokens for changed top-level ext keys so those
// nodes re-run (rebuilding their output schema + meta), while leaving nodes
// that didn't declare the dep — and unchanged ext keys — untouched.

type Ext = { limits: { maxResources: number } };

/**
 * Mirrors the real generation `resources` node: depends on a ctx key
 * (`ecosystem`) AND on `ext.limits`. `runs` counts factory invocations so we
 * can assert the per-key diff in `setExt` avoids redundant re-evaluation.
 */
function makeGraph() {
  const counter = { runs: 0 };
  const graph = new DataGraph<{ ecosystem: string }, Ext>()
    .node('ecosystem', { output: z.string(), defaultValue: 'sd' })
    .node(
      'resources',
      (_ctx, ext) => {
        counter.runs++;
        return {
          output: z.array(z.number()).max(ext.limits.maxResources, 'too many').optional(),
          defaultValue: [] as number[],
          meta: () => ({ limit: ext.limits.maxResources }),
        };
      },
      ['ecosystem', 'ext:limits']
    );
  return { graph, counter };
}

describe('DataGraph external-context deps', () => {
  it('updates a node meta when its ext dep changes', () => {
    const { graph } = makeGraph();
    graph.init({}, { limits: { maxResources: 9 } });

    expect(graph.getSnapshot('resources').meta).toEqual({ limit: 9 });

    graph.setExt({ limits: { maxResources: 12 } });
    expect(graph.getSnapshot('resources').meta).toEqual({ limit: 12 });
  });

  // Note: the node's `.max()` output schema is rebuilt from the same factory
  // closure as `meta`, so the meta test above also proves the schema tracks the
  // new limit. We don't assert it via safeParse/set because `_evaluate` coerces
  // a schema-failing value back to the node default rather than persisting it,
  // so an over-limit array is never observable downstream.

  it('does not re-run a node when setExt receives an equal ext value', () => {
    const { graph, counter } = makeGraph();
    graph.init({}, { limits: { maxResources: 9 } });
    const afterInit = counter.runs;

    // New object reference, structurally equal — must NOT re-run (isEqual diff).
    graph.setExt({ limits: { maxResources: 9 } });
    expect(counter.runs).toBe(afterInit);

    // Genuine change — must re-run exactly once.
    graph.setExt({ limits: { maxResources: 10 } });
    expect(counter.runs).toBe(afterInit + 1);
  });
});
