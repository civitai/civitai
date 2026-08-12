import { describe, expect, it } from 'vitest';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { REMIX_ENGINES } from '~/shared/constants/remix.constants';
import {
  isWorkflowAvailable,
  workflowConfigByKey,
} from '~/shared/data-graph/generation/config/workflows';

/**
 * The Remix button sends the user straight into these workflow/ecosystem pairs
 * with no picker in between. If a pair stops being valid — an ecosystem key is
 * renamed, or an ecosystem is dropped from a workflow's `ecosystemIds` — the
 * button still renders and still opens the panel; the user just lands on the
 * compatibility modal instead of the engine we chose. Nothing else fails, so
 * these assertions are the only thing standing between that and production.
 */
describe('REMIX_ENGINES', () => {
  const entries = Object.entries(REMIX_ENGINES);

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
});
