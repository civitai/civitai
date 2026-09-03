import { z } from 'zod';
import type { FieldDef } from 'form-graph';
import {
  baseModelByName,
  ecosystemById,
  ecosystemByKey,
  getEcosystemDefaults,
} from '~/shared/constants/basemodel.constants';
import { rulesToStates } from '~/shared/data-graph/generation/gates';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import {
  getResourceSelectOptions,
  resourceSchema,
  type CheckpointMeta,
  type ResourceData,
} from './defs';
import type { ModelType } from '~/shared/utils/prisma/enums';

// ---- copied from common.ts, which dies with the data-graph engine ----------

export type VersionOption = {
  label: string;
  value: number;
  /** Base model name for this version (used for ecosystem switching) */
  baseModel?: string;
  /** Child options shown when this option is selected */
  children?: VersionGroup;
};

export type VersionGroup = {
  /** Optional label for this level of the selector (e.g., "Precision", "Variant") */
  label?: string;
  /** Available options at this level */
  options: VersionOption[];
};

/** Collect all version IDs from a VersionGroup (including nested children). */
export function getAllVersionIds(group: VersionGroup): Set<number> {
  const ids = new Set<number>();
  function collect(g: VersionGroup) {
    for (const opt of g.options) {
      ids.add(opt.value);
      if (opt.children) collect(opt.children);
    }
  }
  collect(group);
  return ids;
}

/**
 * Returns a copy of `group` with any option whose `value` is in `hiddenIds`
 * removed. Recurses into `children`; a parent option is dropped when all of
 * its children are hidden, and a parent whose own `value` is hidden is
 * rewritten to point at the first remaining child so selecting the parent
 * doesn't land on a gated ID. Returns `undefined` when every option is gated.
 */
export function filterVersionGroup(
  group: VersionGroup,
  hiddenIds: number[]
): VersionGroup | undefined {
  if (hiddenIds.length === 0) return group;
  const options: VersionOption[] = [];
  for (const opt of group.options) {
    if (opt.children) {
      const filteredChildren = filterVersionGroup(opt.children, hiddenIds);
      if (!filteredChildren) continue;
      const value = hiddenIds.includes(opt.value) ? filteredChildren.options[0]!.value : opt.value;
      options.push({ ...opt, value, children: filteredChildren });
    } else if (!hiddenIds.includes(opt.value)) {
      options.push(opt);
    }
  }
  if (options.length === 0) return undefined;
  return { ...group, options };
}

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
 */

/** common.ts, module-local there: base model name -> ecosystem key. */
export function ecosystemKeyForBaseModel(baseModelName: string): string | undefined {
  const baseModel = baseModelByName.get(baseModelName);
  if (!baseModel) return undefined;
  return ecosystemById.get(baseModel.ecosystemId)?.key;
}

// Static schema pair — the def object itself is rebuilt per pass (cheap),
// while everything ext-dependent (locked substitution, the metrics record)
// lives in `correct`, whose per-pass closure may safely capture the
// request-scoped ext. Never move that into a cached schema: a cached
// transform would keep recording into the FIRST request's collector.
const CHECKPOINT_INPUT = z
  .union([
    z.number().transform((id) => ({ id })),
    z.looseObject({ id: z.number(), baseModel: z.string().optional() }),
  ])
  .optional()
  .transform((val) => {
    if (!val) return undefined;
    if (!('model' in val) || !val.model) {
      return { ...val, model: { type: 'Checkpoint' } };
    }
    return val;
  });
const CHECKPOINT_OUTPUT = resourceSchema.optional();

export function checkpointDef(opts: {
  ecosystem: string;
  workflow: string;
  ext: GenerationCtx;
  versions?: VersionGroup;
  defaultModelId?: number;
  modelLocked?: boolean;
  /**
   * v1's unlocked families make the ECOSYSTEM follow a cross-ecosystem model
   * (the checkpoint effect wins; the reset-to-default transform is dead code
   * there). Set this and derive the effective ecosystem from the model in the
   * family (an `emit: 'ecosystem'` computed) instead of correcting the model.
   */
  modelWins?: boolean;
}) {
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
    input: CHECKPOINT_INPUT,
    output: CHECKPOINT_OUTPUT,
    default: modelVersionId
      ? ({ id: modelVersionId, model: { type: 'Checkpoint' } } as ResourceData)
      : undefined,
    meta: (value) => ({
      options: {
        canGenerate: true,
        // the checkpoint picker never surfaces partial support — v1 zeroes it
        resources: getResourceSelectOptions(ecosystemKey, ['Checkpoint'] as ModelType[]).map(
          (r) => ({ ...r, partialSupport: [] })
        ),
        excludeIds: value ? [value.id] : [],
      },
      modelLocked,
      versions: visibleVersions,
      defaultModelId: modelVersionId,
    }),
    correct: (value) => {
      // Locked substitution (was the input transform's job): an unknown
      // version on a model-locked family swaps to the locked default, with
      // the observe-only substitution record — see common.ts for why; a
      // caller billed for model A and given model B can find out. Runs once
      // per server parse (one resolve pass); client ext has no collector.
      if (modelLocked && modelVersionId && value && value.id !== modelVersionId) {
        if (!validVersionIds?.has(value.id)) {
          ext.modelSubstitutions?.record({
            requested: value.id,
            applied: modelVersionId,
            ecosystem: ecosystemKey,
            workflow,
          });
          return {
            value: { id: modelVersionId, model: { type: 'Checkpoint' } } as ResourceData,
            reason: 'locked_default',
            detail: { ecosystem: ecosystemKey, requested: value.id },
          };
        }
      }
      // data-graph's `transform`, step 1: a model from another ecosystem
      // resets to this ecosystem's default. (Step 2, the workflow-version
      // transform, only applies to graphs configured with `workflowVersions`
      // — not the video ones.)
      if (opts.modelWins) return undefined;
      if (!value?.baseModel || !modelVersionId) return undefined;
      const modelEcosystemKey = ecosystemKeyForBaseModel(value.baseModel);
      if (!modelEcosystemKey || modelEcosystemKey === ecosystemKey) return undefined;
      return {
        value: { id: modelVersionId, model: { type: 'Checkpoint' } } as ResourceData,
        reason: 'ecosystem_mismatch',
        detail: { ecosystem: ecosystemKey, baseModel: value.baseModel },
      };
    },
  } satisfies FieldDef<ResourceData | undefined, CheckpointMeta>;
}
