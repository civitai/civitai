import { describe, expect, it } from 'vitest';
import { ecosystems } from '~/shared/constants/basemodel.constants';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { getWorkflowsForEcosystem } from '~/shared/generation/config/workflows';
import type { GenerationCtx } from '~/shared/generation/context';

/**
 * A generation field def that builds its zod schemas inside the field function rebuilds them
 * on every store pass, which is the dominant cost on the keystroke path. form-graph only
 * warns about it in the browser console, so this walks every ecosystem × workflow (and each
 * `version` option) and fails on any field the store reports as churning.
 *
 * Fix a failure by hoisting the def to module scope, or, when the def depends on graph values,
 * by building it with `cachedFactory` keyed on those values (e.g. `tripoFaceLimitDef`).
 */

const EXT: GenerationCtx = {
  limits: { maxQuantity: 8, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: { model3dGenerator: true, meshyV7Generator: true },
  gateRules: [],
};

/**
 * Fields that churned before this guard existed, as `<ecosystem or workflow> <field>`. A
 * workflow-scoped entry covers every ecosystem the workflow runs under. Remove an entry when
 * its field is fixed; the stale-entry test fails until you do.
 */
const KNOWN_CHURN = new Set([
  'img2img:preprocess kindParams',
  'vid2vid:preprocess kindParams',
  'vid2vid:upscale scaleFactor',
  'vid2vid:interpolate interpolationFactor',
  'img2img:upscale upscaleSelection',
  'Veo3 duration',
  'Vidu enablePromptEnhancer',
  'MossImage turboLora',
]);

// The store flags a key after a few consecutive rebuilt passes; run comfortably past it.
const PASSES = 5;

function storeFor(ecosystem: string, workflow: string, version?: unknown) {
  const store = generationHub.createStore({ ext: EXT, warnOnCodecChurn: false });
  store.set({ workflow, ecosystem });
  if (version !== undefined) store.set({ version } as never);
  for (let i = 0; i < PASSES; i++) store.set({ quantity: (i % 2) + 1 } as never);
  return store;
}

function walk() {
  const found: { ecosystem: string; workflow: string; field: string; at: string }[] = [];
  for (const eco of ecosystems) {
    for (const { graphKey: workflow } of getWorkflowsForEcosystem(eco.id)) {
      const base = storeFor(eco.key, workflow);
      const stores: [typeof base, string][] = [[base, `${eco.key}/${workflow}`]];
      const meta = base.getField('version' as never)?.meta as
        | { options?: { value: unknown }[] }
        | undefined;
      for (const option of meta?.options ?? []) {
        stores.push([
          storeFor(eco.key, workflow, option.value),
          `${eco.key}/${workflow}@${String(option.value)}`,
        ]);
      }
      for (const [store, at] of stores) {
        for (const field of store.getCodecChurn())
          found.push({ ecosystem: eco.key, workflow, field, at });
      }
    }
  }
  return found;
}

const ledgerKey = (c: { ecosystem: string; workflow: string; field: string }) =>
  KNOWN_CHURN.has(`${c.workflow} ${c.field}`)
    ? `${c.workflow} ${c.field}`
    : KNOWN_CHURN.has(`${c.ecosystem} ${c.field}`)
    ? `${c.ecosystem} ${c.field}`
    : undefined;

describe('no generation field rebuilds its schemas on every pass', () => {
  const churn = walk();

  it('walks a meaningful number of stores', () => {
    const pairs = ecosystems.flatMap((eco) => getWorkflowsForEcosystem(eco.id));
    expect(pairs.length).toBeGreaterThan(100);
  });

  it('no new churning field', () => {
    const unledgered = churn.filter((c) => !ledgerKey(c)).map((c) => `${c.at}: ${c.field}`);
    expect([...new Set(unledgered)]).toEqual([]);
  });

  it('no stale KNOWN_CHURN entry', () => {
    const live = new Set(churn.map(ledgerKey).filter(Boolean));
    expect([...KNOWN_CHURN].filter((entry) => !live.has(entry))).toEqual([]);
  });
});
