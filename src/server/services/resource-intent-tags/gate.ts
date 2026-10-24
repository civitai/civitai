import { createHash } from 'crypto';

import { baseModelByName, getCompatibleBaseModels } from '~/shared/constants/basemodel.constants';
import type { MediaType, ModelType } from '~/shared/utils/prisma/enums';
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
 * The index's ecosystem ids with at least `V1_TAGS_MIN_ECOSYSTEM_RESOURCES` of `kind`'s resources in
 * the pool the request gates from: resources the scorer ranks for the ecosystem (published under its
 * own name, or in its user-side compatibility set) that are published under a base model in its
 * gate. Cached per index: a held index is never mutated.
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

  const { ecosystems: published, userByEcosystem } = index.kinds[kind];
  const idByName = new Map(index.ecosystems.map((e, id) => [e.name, id]));
  const publishedFor: number[][] = index.ecosystems.map(() => []);
  published.forEach((ids, r) => ids.forEach((id) => publishedFor[id]?.push(r)));

  const eligible = new Set<number>();
  const countedFor = new Int32Array(published.length).fill(-1);
  index.ecosystems.forEach((e, id) => {
    const gateIds = new Set<number>();
    for (const name of gateBaseModels(ecosystemBaseModelGate(e.name, modelTypes))) {
      const gateId = idByName.get(name);
      if (gateId !== undefined) gateIds.add(gateId);
    }
    // Published under its own name: in the pool, and in the gate (which always holds that name).
    let n = 0;
    for (const r of publishedFor[id]) {
      countedFor[r] = id;
      n++;
    }
    for (const r of userByEcosystem.get(id)?.resource ?? []) {
      if (countedFor[r] === id || !published[r].some((p) => gateIds.has(p))) continue;
      countedFor[r] = id;
      n++;
    }
    if (n >= V1_TAGS_MIN_ECOSYSTEM_RESOURCES) eligible.add(id);
  });
  byKey.set(key, eligible);
  return eligible;
}

/**
 * The media type a v1_tags request generates. Image only: the request carries no media type, and the
 * route's stage-3 question (resource-intent.schema.ts) states the prompt is an image-generation
 * prompt. A request that can be
 * a video one must pass its own media type here instead of this constant.
 */
export const V1_TAGS_REQUEST_MEDIA_TYPE: MediaType = 'image';

/**
 * Whether `baseModel` generates `mediaType`, read from its base-model record's `type` (one media
 * type, or several for a model that generates more than one). A name with no record has no known
 * media type and is not excluded. The one modality predicate of the tag-chosen ecosystem.
 */
export function baseModelGeneratesMediaType(baseModel: string, mediaType: MediaType): boolean {
  const type = baseModelByName.get(baseModel)?.type;
  if (type === undefined) return true;
  return Array.isArray(type) ? type.includes(mediaType) : type === mediaType;
}

const modalityCache = new WeakMap<object, Map<MediaType, ReadonlySet<number>>>();

/**
 * The index's ecosystem ids whose base model generates `mediaType` (`baseModelGeneratesMediaType`):
 * the only ecosystems the tags may choose for a request of that media type. Cached per index.
 */
export function modalityEligibleEcosystems(
  index: Pick<TagIndex, 'ecosystems'>,
  mediaType: MediaType
): ReadonlySet<number> {
  const byType = modalityCache.get(index) ?? new Map<MediaType, ReadonlySet<number>>();
  modalityCache.set(index, byType);
  const cached = byType.get(mediaType);
  if (cached) return cached;
  const eligible = new Set<number>();
  index.ecosystems.forEach((e, id) => {
    if (baseModelGeneratesMediaType(e.name, mediaType)) eligible.add(id);
  });
  byType.set(mediaType, eligible);
  return eligible;
}

/**
 * Hashes the floor, the request's media type, and what the gate, the eligibility count and the
 * modality predicate produce on fixed inputs, so the v1 cache key moves when any of them does.
 * Request-path only: the snapshot is keyed by `RESOURCE_INTENT_TAGS_SPEC_HASH`, which this must not
 * feed. Exported for its test.
 */
export function v1GateFingerprint() {
  const types: ModelType[] = ['LORA', 'LoCon', 'DoRA', 'TextualInversion'];
  const names = ['Krea 2 Turbo', 'Krea 2', 'SDXL Lightning', 'SDXL 1.0', 'NoobAI', 'Illustrious'];
  const n = V1_TAGS_MIN_ECOSYSTEM_RESOURCES;
  const index = {
    ecosystems: names.map((name) => ({ name, users: 0, observations: 0 })),
    kinds: {
      addon: {
        // Krea 2 Turbo: 1 own and n - 1 of Krea 2's used with it (eligible); Krea 2: n - 1 own
        // (not); SDXL 1.0: n own (eligible); SDXL Lightning: SDXL 1.0's, none used with it (not).
        ecosystems: [
          [0],
          ...Array.from({ length: n - 1 }, () => [1]),
          ...Array.from({ length: n }, () => [3]),
        ],
        userByEcosystem: new Map([[0, { resource: Uint32Array.from({ length: n }, (_, i) => i) }]]),
      },
      checkpoint: { ecosystems: [], userByEcosystem: new Map() },
    },
  } as unknown as Pick<TagIndex, 'ecosystems' | 'kinds'>;
  // One of each media-type shape: image, video, image and video, audio, and no record.
  const modalityNames = ['SDXL 1.0', 'MiniMax H3', 'Grok', 'ACE Audio', 'Not A Base Model'];
  const modalityIndex = {
    ecosystems: modalityNames.map((name) => ({ name, users: 0, observations: 0 })),
  };
  return {
    minResources: n,
    gates: names.map((name) => [...ecosystemBaseModelGate(name, types)]),
    eligible: [...gateEligibleEcosystems(index, 'addon', types)],
    mediaType: V1_TAGS_REQUEST_MEDIA_TYPE,
    modalityEligible: [...modalityEligibleEcosystems(modalityIndex, V1_TAGS_REQUEST_MEDIA_TYPE)],
  };
}

export const RESOURCE_INTENT_V1_GATE_SPEC_HASH = createHash('sha256')
  .update(JSON.stringify(v1GateFingerprint()))
  .digest('hex');
