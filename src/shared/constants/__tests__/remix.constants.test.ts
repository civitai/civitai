import { describe, expect, it } from 'vitest';
import { ecosystemByKey, getEcosystemSetting } from '~/shared/constants/basemodel.constants';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
import {
  isWorkflowAvailable,
  workflowConfigByKey,
} from '~/shared/data-graph/generation/config/workflows';
import {
  minimaxVersionIds,
  nanoBananaVersionIds,
  qwenVersionIds,
} from '~/shared/data-graph/generation/version-ids';

/**
 * The Remix button sends the user straight into these workflow/ecosystem pairs
 * with no picker in between. If a pair stops being valid — an ecosystem key is
 * renamed, or an ecosystem is dropped from a workflow's `ecosystemIds` — the
 * button still renders and still opens the panel; the user just lands on the
 * compatibility modal instead of the engine we chose. Nothing else fails, so
 * these assertions are the only thing standing between that and production.
 */
describe('REMIX_ENGINES', () => {
  const entries = Object.entries(REMIX_ENGINES).flatMap(([kind, byTier]) =>
    Object.entries(byTier).map(([tier, engine]) => [`${kind}/${tier}`, engine] as const)
  );

  it.each(entries)('%s names a workflow that exists', (_kind, engine) => {
    expect(workflowConfigByKey.has(engine.workflow)).toBe(true);
  });

  it.each(entries)('%s names an ecosystem that exists', (_kind, engine) => {
    expect(ecosystemByKey.get(engine.ecosystemKey)).toBeDefined();
  });

  it.each(entries)('%s pairs a workflow with an ecosystem that supports it', (_kind, engine) => {
    const ecosystem = ecosystemByKey.get(engine.ecosystemKey);
    expect(ecosystem).toBeDefined();
    expect(isWorkflowAvailable(engine.workflow, ecosystem!.id)).toBe(true);
  });

  it.each(entries)('%s pins a checkpoint version', (_kind, engine) => {
    expect(Number.isInteger(engine.modelVersionId)).toBe(true);
    expect(engine.modelVersionId).toBeGreaterThan(0);
  });

  // The ids are what actually select the engine, and picking the wrong one is
  // silent: the panel opens on a working generator, just not the one we chose.
  // NanoBanana in particular falls back to `standard` for an unrecognised id,
  // so a revert of the v2lite pin looks identical to a correct one at runtime.
  it('safe edit resolves to Nano Banana 2 Light, not the standard fallback', () => {
    expect(REMIX_ENGINES.edit.safe.modelVersionId).toBe(nanoBananaVersionIds.v2lite);
    expect(REMIX_ENGINES.edit.safe.modelVersionId).not.toBe(nanoBananaVersionIds.standard);
  });

  // If you are here to point Animate at a newer or cheaper video engine: H3 is
  // the platform's default video engine under a commercial commitment with a
  // fixed term, and Animate is one of the two surfaces that decides what
  // "default" means in practice. Ask Justin before changing it — the reason to
  // leave it alone is not visible anywhere in this codebase.
  it('routes Animate to MiniMax H3 on both tiers', () => {
    expect(REMIX_ENGINES.video.safe.ecosystemKey).toBe('MiniMaxH3');
    expect(REMIX_ENGINES.video.mature.ecosystemKey).toBe('MiniMaxH3');
    expect(REMIX_ENGINES.video.safe.modelVersionId).toBe(minimaxVersionIds.comfy);
    expect(REMIX_ENGINES.video.mature.modelVersionId).toBe(minimaxVersionIds.comfy);
  });

  // `h3-ids-agree`, referenced from remix.constants.ts. The generator resolves
  // H3's variant by version id and falls back to MiniMax's HOSTED API on any id
  // it doesn't know, so a bump that moves the ecosystem default without moving
  // `minimaxVersionIds.comfy` sends both tiers — mature included — off our own
  // orchestrator with nothing red. The assertion above cannot see that: it
  // compares the table against the same constant the table was built from.
  it('h3-ids-agree: the pinned H3 version is still the ecosystem default', () => {
    const h3 = ecosystemByKey.get('MiniMaxH3');
    expect(h3, 'no MiniMaxH3 ecosystem registered').toBeDefined();
    expect(getEcosystemSetting(h3!.id, 'model')?.id).toBe(minimaxVersionIds.comfy);
  });

  // The two video entries are equal today. They are still two OBJECTS, and
  // remix.utils.test.ts's tier-routing test discriminates only by reference, so
  // collapsing them to one shared value turns that test into an object compared
  // against itself — passing, covering nothing. Keep them separate.
  it('keeps the two video tiers separately addressable', () => {
    expect(REMIX_ENGINES.video.mature).not.toBe(REMIX_ENGINES.video.safe);
  });

  // The whole point of the tier split: a mature image must not be routed to an
  // engine whose provider will refuse it. If someone collapses these back to one
  // entry, the failure in production is a charged request that returns nothing.
  it('routes mature edits away from the external provider', () => {
    expect(REMIX_ENGINES.edit.mature.ecosystemKey).not.toBe(REMIX_ENGINES.edit.safe.ecosystemKey);
    expect(REMIX_ENGINES.edit.mature.modelVersionId).toBe(qwenVersionIds.imageEdit2511);
  });
});
