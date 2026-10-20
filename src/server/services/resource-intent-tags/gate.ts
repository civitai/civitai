import { baseModelByName, getCompatibleBaseModels } from '~/shared/constants/basemodel.constants';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { TAG_SCORE_PARAMS, type TagIndex, type TagKind } from './score';

/** Per model type, the base models a listed version may carry. */
export type BaseModelGate = ReadonlyMap<ModelType, readonly string[]>;

/**
 * The base models whose resources of each type generate on a checkpoint of `baseModel`'s ecosystem,
 * fully or partially, as the generation form's resource picker accepts them. `baseModel` itself
 * always passes, so a name with no record gates exactly as an exact-name filter would.
 */
export function ecosystemBaseModelGate(
  baseModel: string,
  modelTypes: readonly ModelType[]
): BaseModelGate {
  const key = `${baseModel}\u0000${modelTypes.join(',')}`;
  let gate = gateCache.get(key);
  if (!gate) {
    gate = buildGate(baseModel, modelTypes);
    gateCache.set(key, gate);
  }
  return gate;
}

// The base-model records are constants, so a gate never changes for a process. Bounded only while
// every caller passes an index's ecosystem name, never request input.
const gateCache = new Map<string, BaseModelGate>();

function buildGate(baseModel: string, modelTypes: readonly ModelType[]): BaseModelGate {
  const record = baseModelByName.get(baseModel);
  return new Map(
    modelTypes.map((type) => {
      const names = new Set([baseModel]);
      if (record) {
        const { full, partial } = getCompatibleBaseModels(record.ecosystemId, type);
        for (const m of [...full, ...partial]) names.add(m.name);
      }
      return [type, [...names]];
    })
  );
}

export function gateBaseModels(gate: BaseModelGate): string[] {
  return [...new Set([...gate.values()].flat())];
}

/**
 * A tag-chosen ecosystem needs at least this many of the kind's resources published under its gate:
 * as many as the scorer keeps for the request-time gates. One that cannot fill that list from its
 * own catalogue can still win on tag lift, and then lists next to nothing.
 */
export const V1_TAGS_MIN_ECOSYSTEM_RESOURCES = TAG_SCORE_PARAMS.maxCandidates;

const eligibleCache = new WeakMap<object, Map<string, ReadonlySet<number>>>();

/**
 * The index's ecosystem ids with at least `V1_TAGS_MIN_ECOSYSTEM_RESOURCES` of `kind`'s resources
 * published for a base model in their gate. Cached per index: a held index is never mutated.
 */
export function gateEligibleEcosystems(
  index: Pick<TagIndex, 'ecosystems' | 'kinds'>,
  kind: TagKind,
  modelTypes: readonly ModelType[]
): ReadonlySet<number> {
  const key = `${kind}:${modelTypes.join(',')}`;
  const byKey = eligibleCache.get(index) ?? new Map<string, ReadonlySet<number>>();
  eligibleCache.set(index, byKey);
  const cached = byKey.get(key);
  if (cached) return cached;

  const idByName = new Map(index.ecosystems.map((e, id) => [e.name, id]));
  // Inverted, so each resource is visited once: per published ecosystem id, the gates admitting it.
  const admittedBy: number[][] = index.ecosystems.map(() => []);
  index.ecosystems.forEach((e, id) => {
    for (const name of gateBaseModels(ecosystemBaseModelGate(e.name, modelTypes))) {
      const published = idByName.get(name);
      if (published !== undefined) admittedBy[published].push(id);
    }
  });

  const counts = new Uint32Array(index.ecosystems.length);
  const countedFor = new Int32Array(index.ecosystems.length).fill(-1);
  index.kinds[kind].ecosystems.forEach((published, r) => {
    for (const p of published)
      for (const id of admittedBy[p] ?? []) {
        if (countedFor[id] === r) continue;
        countedFor[id] = r;
        counts[id]++;
      }
  });

  const eligible = new Set<number>();
  counts.forEach((n, id) => {
    if (n >= V1_TAGS_MIN_ECOSYSTEM_RESOURCES) eligible.add(id);
  });
  byKey.set(key, eligible);
  return eligible;
}
