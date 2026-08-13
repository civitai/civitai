import { describe, expect, it } from 'vitest';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
import {
  isWorkflowAvailable,
  workflowConfigByKey,
} from '~/shared/data-graph/generation/config/workflows';
import {
  ltxVersionIds,
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

  it('video resolves to LTX 2.3 when safe and Sulphur 2 when mature', () => {
    expect(REMIX_ENGINES.video.safe.modelVersionId).toBe(ltxVersionIds.v23Dev);
    expect(REMIX_ENGINES.video.mature.modelVersionId).toBe(ltxVersionIds.sulphur2Dev);
  });

  // Sulphur 2 runs through the LTXV23 ecosystem, so unlike the edit tiers the
  // ecosystem key is deliberately the SAME on both — only the version differs.
  // Asserting that keeps someone from "fixing" it to a nonexistent ecosystem.
  it('keeps both video tiers on the LTXV23 ecosystem', () => {
    expect(REMIX_ENGINES.video.mature.ecosystemKey).toBe(REMIX_ENGINES.video.safe.ecosystemKey);
    expect(REMIX_ENGINES.video.mature.modelVersionId).not.toBe(
      REMIX_ENGINES.video.safe.modelVersionId
    );
  });

  // The whole point of the tier split: a mature image must not be routed to an
  // engine whose provider will refuse it. If someone collapses these back to one
  // entry, the failure in production is a charged request that returns nothing.
  it('routes mature edits away from the external provider', () => {
    expect(REMIX_ENGINES.edit.mature.ecosystemKey).not.toBe(REMIX_ENGINES.edit.safe.ecosystemKey);
    expect(REMIX_ENGINES.edit.mature.modelVersionId).toBe(qwenVersionIds.imageEdit2511);
  });
});
