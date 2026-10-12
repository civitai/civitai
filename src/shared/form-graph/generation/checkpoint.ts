import { z } from 'zod';
import type { FieldDef } from 'form-graph';
import {
  baseModelByName,
  ecosystemById,
  ecosystemByKey,
  getEcosystemDefaults,
} from '~/shared/constants/basemodel.constants';
import { unselectableVersionIds } from '~/shared/generation/gates';
import type { GenerationCtx } from '~/shared/generation/context';
import {
  getResourceSelectOptions,
  resourceSchema,
  type CheckpointMeta,
  type ResourceData,
} from './defs';
import type { ModelType } from '~/shared/utils/prisma/enums';

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
 * The shared checkpoint field. Three things affect the VALUE, and all three are
 * `correct` policies rather than silent rewrites, so each leaves a note the
 * server's substitution metric can read:
 *
 * - the locked substitution — an id outside a model-locked family's visible list
 *   becomes that workflow's default,
 * - the cross-ecosystem reset — a model from another ecosystem becomes this one's
 *   default,
 * - the default itself (the ecosystem's model version).
 *
 * The ecosystem/workflow-SWITCHING behaviour is not here: those are rules, and
 * they live on the family graph that mounts this definition.
 */

export function ecosystemKeyForBaseModel(baseModelName: string): string | undefined {
  const baseModel = baseModelByName.get(baseModelName);
  if (!baseModel) return undefined;
  return ecosystemById.get(baseModel.ecosystemId)?.key;
}

// Static schema pair — the def object itself is rebuilt per pass (cheap), while
// everything ext-dependent (the locked substitution, the gate-rule exclusions) lives
// in `correct`/`meta`, whose per-pass closure may safely capture the request-scoped
// ext. Never move that into a cached schema: a cached closure would answer every
// later request from the FIRST request's gate rules.
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
   * Unlocked families make the ECOSYSTEM follow a cross-ecosystem model rather
   * than resetting the model to the ecosystem default. Set this and derive the effective ecosystem from the model in the
   * family (an `emit: 'ecosystem'` computed) instead of correcting the model.
   */
  modelWins?: boolean;
}) {
  const { ecosystem: ecosystemKey, workflow, ext, versions, defaultModelId } = opts;
  const ecosystem = ecosystemByKey.get(ecosystemKey);
  const ecosystemDefaults = ecosystem ? getEcosystemDefaults(ecosystem.id) : undefined;
  const modelVersionId = defaultModelId ?? ecosystemDefaults?.model?.id;
  const modelLocked = opts.modelLocked ?? ecosystemDefaults?.modelLocked ?? false;

  // A `disabled` version stays in the picker and is refused at whatIf/submit
  // instead; see `unselectableVersionIds`.
  const ruleVersionIds = unselectableVersionIds(ext.gateRules ?? []);
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
      // An unknown version on a model-locked family swaps to the locked default.
      // The `locked_default` note is the server's only record of that:
      // `substitutionsFromNotes` turns it into the substitution metric, so a caller
      // billed for model A and given model B can find out.
      if (modelLocked && modelVersionId && value && value.id !== modelVersionId) {
        if (!validVersionIds?.has(value.id)) {
          return {
            value: { id: modelVersionId, model: { type: 'Checkpoint' } } as ResourceData,
            reason: 'locked_default',
            detail: { ecosystem: ecosystemKey, requested: value.id },
          };
        }
      }
      // A model from another ecosystem resets to this ecosystem's default. The
      // workflow-version reset is separate and applies only to graphs configured
      // with `workflowVersions` — not the video ones.
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
