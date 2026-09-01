import { z } from 'zod';
import type { FieldDef } from 'form-graph';
import {
  baseModelByName,
  ecosystemById,
  ecosystemByKey,
  getEcosystemDefaults,
} from '~/shared/constants/basemodel.constants';
import { getAllVersionIds, type VersionGroup } from '~/shared/data-graph/generation/common';
import { rulesToStates } from '~/shared/data-graph/generation/gates';
import { filterVersionGroup } from '~/shared/data-graph/generation/common';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { resourceSchema, type CheckpointMeta, type ResourceData } from './defs';

/**
 * The model node from common.ts `createCheckpointGraph`, as a form-graph
 * definition. Only the parts that affect the VALUE are transcribed:
 *
 * - the input transform's locked substitution (with the substitution-metrics
 *   record, which production reads),
 * - the default (the ecosystem's model version),
 * - data-graph's `transform` — reset to the ecosystem default when the model
 *   belongs to a different ecosystem — which becomes a `correct` policy here,
 *   so the swap is recorded as a note instead of happening silently.
 *
 * The node's ecosystem/workflow-switching EFFECTS are not here: they are rules,
 * and they live on the family graph that mounts this definition.
 *
 * `meta` carries only what is cheap and value-derived; the picker's resource
 * option list is a UI concern that never reaches parsed data.
 */

/** common.ts, module-local there: base model name -> ecosystem key. */
function ecosystemKeyForBaseModel(baseModelName: string): string | undefined {
  const baseModel = baseModelByName.get(baseModelName);
  if (!baseModel) return undefined;
  return ecosystemById.get(baseModel.ecosystemId)?.key;
}

export function checkpointDef(opts: {
  ecosystem: string;
  workflow: string;
  ext: GenerationCtx;
  versions?: VersionGroup;
  defaultModelId?: number;
  modelLocked?: boolean;
}): FieldDef<ResourceData | undefined, CheckpointMeta> {
  const { ecosystem: ecosystemKey, workflow, ext, versions, defaultModelId } = opts;
  const ecosystem = ecosystemByKey.get(ecosystemKey);
  const ecosystemDefaults = ecosystem ? getEcosystemDefaults(ecosystem.id) : undefined;
  const modelVersionId = defaultModelId ?? ecosystemDefaults?.model?.id;
  const modelLocked = opts.modelLocked ?? ecosystemDefaults?.modelLocked ?? false;

  // Gate-hidden versions never reach the picker; the server enforces the same.
  const ruleVersionIds = [...rulesToStates(ext.gateRules ?? []).modelVersionIds.keys()];
  const visibleVersions =
    versions && ruleVersionIds.length ? filterVersionGroup(versions, ruleVersionIds) : versions;
  const validVersionIds = visibleVersions ? getAllVersionIds(visibleVersions) : undefined;

  return {
    input: z
      .union([
        z.number().transform((id) => ({ id })),
        z.looseObject({ id: z.number(), baseModel: z.string().optional() }),
      ])
      .optional()
      .transform((val) => {
        if (!val) return undefined;
        if (modelLocked && modelVersionId && val.id !== modelVersionId) {
          if (!validVersionIds?.has(val.id)) {
            // Observe-only substitution record — see common.ts for why this
            // exists; a caller billed for model A and given model B can find out.
            ext.modelSubstitutions?.record({
              requested: val.id,
              applied: modelVersionId,
              ecosystem: ecosystemKey,
              workflow,
            });
            return { id: modelVersionId, model: { type: 'Checkpoint' } };
          }
        }
        if (!('model' in val) || !val.model) {
          return { ...val, model: { type: 'Checkpoint' } };
        }
        return val;
      }) as unknown as z.ZodType<ResourceData | undefined>,
    output: resourceSchema.optional() as unknown as z.ZodType<ResourceData | undefined>,
    default: modelVersionId
      ? ({ id: modelVersionId, model: { type: 'Checkpoint' } } as ResourceData)
      : undefined,
    meta: (value) => ({
      modelLocked,
      versions: visibleVersions,
      defaultModelId: modelVersionId,
      excludeIds: value ? [value.id] : [],
    }),
    // data-graph's `transform`, step 1: a model from another ecosystem resets to
    // this ecosystem's default. (Step 2, the workflow-version transform, only
    // applies to graphs configured with `workflowVersions` — not the video ones.)
    correct: (value) => {
      if (!value?.baseModel || !modelVersionId) return undefined;
      const modelEcosystemKey = ecosystemKeyForBaseModel(value.baseModel);
      if (!modelEcosystemKey || modelEcosystemKey === ecosystemKey) return undefined;
      return {
        value: { id: modelVersionId, model: { type: 'Checkpoint' } } as ResourceData,
        reason: 'ecosystem_mismatch',
        detail: { ecosystem: ecosystemKey, baseModel: value.baseModel },
      };
    },
  };
}
