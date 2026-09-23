import type { RuleMap } from 'form-graph';
import { ecosystemByKey, getBaseModelsByEcosystemId } from '~/shared/constants/basemodel.constants';
import {
  getEcosystemsForWorkflow,
  getOutputTypeForWorkflow,
  workflowOptions,
} from '~/shared/data-graph/generation/config/workflows';
import { resolveCompatibleEcosystem } from './ecosystem-gates';

/**
 * v1 `getTargetWorkflowForEcosystem`, the pure half: the workflow an
 * ecosystem lands on when the current one doesn't support it. Prefers a
 * workflow of the current output type, then the first compatible one in
 * picker order, then a media-type default.
 */
export function targetWorkflowForEcosystem(
  ecosystemKey: string,
  currentOutputType: string | undefined
): string {
  const targetEcosystemId = ecosystemByKey.get(ecosystemKey)?.id;

  const compatibleWorkflows = workflowOptions.filter((w) => {
    const ecosystemIds = getEcosystemsForWorkflow(w.id);
    return ecosystemIds.length > 0 && targetEcosystemId !== undefined
      ? ecosystemIds.includes(targetEcosystemId)
      : false;
  });

  if (currentOutputType) {
    const sameOutputType = compatibleWorkflows.find(
      (w) => getOutputTypeForWorkflow(w.id) === currentOutputType
    );
    if (sameOutputType) return sameOutputType.id;
  }
  if (compatibleWorkflows[0]) return compatibleWorkflows[0].id;

  const isVideoEcosystem =
    targetEcosystemId !== undefined &&
    getBaseModelsByEcosystemId(targetEcosystemId).some((m) =>
      Array.isArray(m.type) ? m.type.includes('video') : m.type === 'video'
    );
  return isVideoEcosystem ? 'txt2vid' : 'txt2img';
}

type SelectorState = { workflow?: string; ecosystem?: string };

/**
 * Selector coherence, owned by the GRAPH rather than UI handlers: a write
 * that would leave workflow/ecosystem incompatible gets the other selector
 * retargeted in the SAME patch, before resolution — so the keyed ecosystem
 * branch can never see a value with no arm, whoever the writer is (picker,
 * preset, remix, handoff, test).
 *
 * Stored values always win when valid: each rule no-ops when the effective
 * pair is compatible (`resolveCompatibleEcosystem` returning the value
 * unchanged covers the wan-style workflow-group overrides too).
 *
 * Order matters: the ecosystem rule runs first, so on a two-key write the
 * workflow rule sees the already-reconciled pair and stays out — the
 * ecosystem gesture wins.
 */
export const selectorCoherence: RuleMap<SelectorState> = {
  ecosystem: (value: string, { next }) => {
    if (!ecosystemByKey.has(value)) return;
    const workflow = (next as SelectorState).workflow;
    if (workflow && resolveCompatibleEcosystem(workflow, value) === value) return;
    return {
      workflow: targetWorkflowForEcosystem(
        value,
        workflow ? getOutputTypeForWorkflow(workflow) : undefined
      ),
    };
  },
  workflow: (value: string, { state, next }) => {
    const { ecosystem } = next as SelectorState;
    if (!ecosystem || !ecosystemByKey.has(ecosystem)) return;
    // Cross-output switches are handled by the per-output scoped buckets
    // (ecosystem@image / ecosystem@video remember the last choice); writing
    // here would clobber that memory with a stale value.
    if (getOutputTypeForWorkflow(value) !== (state as { output?: string }).output) return;
    // Standalone workflows have no ecosystem field — a write would land at
    // the bare key and leak into every output type's fallback.
    if (getEcosystemsForWorkflow(value).length === 0) return;
    // Stickiness is the STORE's job now (adopted defaults — the displayed
    // value is already intent); this rule only redirects when the new
    // workflow genuinely can't serve the current ecosystem.
    const resolved = resolveCompatibleEcosystem(value, ecosystem);
    if (resolved !== ecosystem) return { ecosystem: resolved };
  },
};
