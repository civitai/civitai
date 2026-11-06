import { cachedFactory, defineGraph } from 'form-graph';
import type { FieldDef } from 'form-graph';
import {
  ecosystemByKey,
  getEcosystemTurboSettings,
  type TurboSettings,
} from '~/shared/constants/basemodel.constants';
import { asResourceValue, defaultStrength } from '~/shared/utils/resource.utils';
import { TURBO_VARIANT_MODEL_TYPES } from '~/shared/constants/generation.constants';
import type { GenerationResource } from '~/shared/types/generation.types';
import {
  getResourceSelectOptions,
  resourceInputSchema,
  resourceSchema,
  resourcesDef,
  sliderDef,
  type ResourceData,
  type ResourcesMeta,
} from './defs';
import { modelIdOf, perModelScope, perModelSlider } from './shared';

/** A family's Turbo toggle: the LoRA it starts on where a checkpoint names none of its own. */
export interface TurboOption {
  lora: number;
}

type SliderOpts = Parameters<typeof sliderDef>[0];

/** The ecosystem's turbo presets: stand in for a default LoRA the toggle added before it is hydrated. */
function ecosystemTurboSettings(ecosystemKey: string): TurboSettings | undefined {
  const ecosystem = ecosystemByKey.get(ecosystemKey);
  return ecosystem ? getEcosystemTurboSettings(ecosystem.id) : undefined;
}

function defaultTurboLora(turbo: TurboOption, model: unknown): ResourceData {
  const own = (model as ResourceData | undefined)?.settings?.turboLora;
  return own ? turboLoraValue(own.id, own.strength) : turboLoraValue(turbo.lora);
}

export interface TurboLoraMeta {
  options: ResourcesMeta['options'] & { turboOnly: true };
  /** The family's default; what Turbo falls back to when the pick cannot be generated with. */
  familyDefaultId: number;
}

const turboLoraOptions = cachedFactory((ecosystem: string) =>
  getResourceSelectOptions(ecosystem, [...TURBO_VARIANT_MODEL_TYPES])
);

/** Strength left unset defers to the LoRA's own default once it is hydrated. */
export const turboLoraValue = (id: number, strength?: number): ResourceData => ({
  id,
  model: { type: 'LORA' },
  ...(strength != null ? { strength } : {}),
});

const turboLoraInput = resourceInputSchema.optional();
const turboLoraOutput = resourceSchema.optional();

/**
 * Not cached: `model` is request-supplied, so a cache keyed on it would grow without bound.
 * `toOutput` drops the pick; the request carries the LoRA in `resources`.
 */
function turboLoraDef(opts: { ecosystem: string; turbo: TurboOption; model: unknown }) {
  const options = turboLoraOptions(opts.ecosystem);
  return {
    input: turboLoraInput,
    output: turboLoraOutput,
    default: defaultTurboLora(opts.turbo, opts.model),
    toOutput: () => undefined,
    meta: (value) => ({
      options: {
        canGenerate: true,
        resources: options,
        excludeIds: value ? [value.id] : [],
        turboOnly: true as const,
      },
      familyDefaultId: opts.turbo.lora,
    }),
  } satisfies FieldDef<ResourceData | undefined, TurboLoraMeta>;
}

/** What the Turbo toggle reads and writes. A turbo LoRA in `resources` is Turbo on. */
export interface ResourcesTurboMeta {
  enabled: boolean;
  /** No free slot to turn it on. */
  full: boolean;
  /** The turbo LoRA the row shows: the last one in the list. */
  active: ResourceData | undefined;
  withoutTurbo: ResourceData[];
}

/** The resources meta's turbo part; undefined where the family has no toggle. */
export const turboMetaOf = (meta: unknown) =>
  (meta as { turbo?: ResourcesTurboMeta } | undefined)?.turbo;

/**
 * The Additional Resources list beside a mounted toggle: the turbo LoRA is the row's, so the
 * list neither shows it nor may drop it, and it takes one of the slots.
 */
export function additionalResources<T>(
  turbo: ResourcesTurboMeta | undefined,
  value: T[] | undefined,
  limit: number | undefined
) {
  const active = turbo?.active;
  return {
    value: (turbo ? turbo.withoutTurbo : value) as T[] | undefined,
    limit: limit != null && active ? limit - 1 : limit,
    commit: (next: T[]): T[] => (active ? [...next, active as T] : next),
  };
}

/** A hydrated LoRA carries the flag; a bare id is turbo when it is the family's default or the pick. */
const isTurboResource = (resource: unknown, familyDefaultId: number, pick?: ResourceData) => {
  const r = resource as ResourceData | null | undefined;
  if (!r || typeof r.id !== 'number') return false;
  return !!r.turbo || r.id === familyDefaultId || r.id === pick?.id;
};

/** The last to arrive wins: a turbo LoRA brought in by any route replaces the one before it. */
const activeTurboLora = (
  resources: readonly unknown[] | undefined,
  familyDefaultId: number,
  pick?: ResourceData
): ResourceData | undefined => {
  if (!resources) return undefined;
  for (let i = resources.length - 1; i >= 0; i--) {
    if (isTurboResource(resources[i], familyDefaultId, pick)) return resources[i] as ResourceData;
  }
  return undefined;
};

function turboResourcesDef(opts: {
  ecosystem: string;
  limit: number;
  turbo: TurboOption;
  turboLora: ResourceData | undefined;
}) {
  const { ecosystem, limit, turbo, turboLora } = opts;
  const def = resourcesDef({ ecosystem, limit });
  const isTurbo = (r: unknown) => isTurboResource(r, turbo.lora, turboLora);
  return {
    ...def,
    meta: (value: ResourceData[] | undefined) => {
      const resources = value ?? [];
      const base = def.meta(resources);
      const active = activeTurboLora(resources, turbo.lora, turboLora);
      return {
        ...base,
        // The Turbo row owns turbo LoRAs.
        options: { ...base.options, excludeTurbo: true },
        turbo: {
          enabled: !!active,
          full: !active && resources.length >= limit,
          active,
          withoutTurbo: resources.filter((r) => !isTurbo(r)),
        } satisfies ResourcesTurboMeta,
      };
    },
    // One turbo LoRA at most: two distillations fight, and the row has one slot.
    correct: (value: ResourceData[]) => {
      const corrected = def.correct(value);
      const resources = corrected ? (corrected.value as ResourceData[]) : value;
      const active = activeTurboLora(resources, turbo.lora, turboLora);
      if (!active || resources.filter(isTurbo).length < 2) return corrected;
      return {
        value: resources.filter((r) => r === active || !isTurbo(r)),
        reason: 'turbo_lora_replaced',
        detail: { kept: active.id },
      };
    },
  };
}

export type TurboToAdd =
  | { status: 'loading' }
  | { status: 'ready'; lora: ResourceData }
  | { status: 'fallback'; lora: ResourceData }
  | { status: 'unavailable' };

export function turboLoraToAdd(args: {
  pick: ResourceData;
  hydrated: GenerationResource | undefined;
  loading: boolean;
  familyDefaultId: number;
  familyDefault: GenerationResource | undefined;
}): TurboToAdd {
  const { pick, hydrated, loading, familyDefaultId, familyDefault } = args;
  if (loading) return { status: 'loading' };
  if (hydrated && hydrated.canGenerate !== false) {
    return {
      status: 'ready',
      lora: asResourceValue(hydrated, pick.strength),
    };
  }
  if (familyDefaultId === pick.id) return { status: 'unavailable' };
  return {
    status: 'fallback',
    lora: {
      ...(familyDefault ?? turboLoraValue(familyDefaultId)),
      strength: familyDefault ? defaultStrength(familyDefault) : 1,
    },
  };
}

type TurboSliderCtx = {
  _ext: { ecosystem: string; model?: unknown };
  resources?: readonly unknown[];
  turboLora?: ResourceData;
};

/** The band is clamped to the graph's range, never widening it: the range is the server's bound and a LoRA's block is client-supplied. */
const turboAwareSlider =
  (opts: SliderOpts, key: keyof TurboSettings, turbo: TurboOption) => (ctx: TurboSliderCtx) => {
    const { _ext, resources, turboLora } = ctx;
    const active = activeTurboLora(resources, turbo.lora, turboLora);
    const band =
      active &&
      (active.recommendedSettings?.[key] ?? ecosystemTurboSettings(_ext.ecosystem)?.[key]);
    if (!active || !band) return perModelSlider(opts)(ctx);
    const clamp = (v: number) => Math.min(opts.max, Math.max(opts.min, v));
    const recommended = { min: clamp(band.min), max: clamp(band.max) };
    const modelId = modelIdOf(_ext.model);
    const def = sliderDef(opts);
    return {
      ...def,
      default: clamp(band.default),
      meta: { ...def.meta, recommended },
      scope: [...(modelId != null ? [modelId] : []), 'turbo', active.id],
    };
  };

type ResourceBlockNeeds = {
  ecosystem: string;
  limits: { maxResources: number };
  model?: unknown;
};

type TurboRuleState = { model?: unknown; turboLora?: ResourceData; resources?: unknown };

/**
 * A checkpoint switch swaps only a toggle-added default: the ecosystem's LoRAs work across
 * its checkpoints, so a chosen one stays. A patch that brings its own resources (a remix) wins.
 */
export function comfyResourceBlock(opts: {
  cfgScale?: SliderOpts;
  steps?: SliderOpts;
  turbo?: TurboOption;
}) {
  const { turbo } = opts;
  const slider = (sliderOpts: SliderOpts | undefined, key: keyof TurboSettings) =>
    !sliderOpts
      ? () => null
      : turbo
      ? turboAwareSlider(sliderOpts, key, turbo)
      : perModelSlider(sliderOpts);
  return defineGraph<ResourceBlockNeeds>()
    .field('turboLora', ({ _ext }) =>
      turbo
        ? {
            ...turboLoraDef({ ecosystem: _ext.ecosystem, turbo, model: _ext.model }),
            scope: perModelScope({ model: _ext.model }),
          }
        : null
    )
    .field('resources', ({ _ext, turboLora }) => {
      const base = { ecosystem: _ext.ecosystem, limit: _ext.limits.maxResources };
      return turbo ? turboResourcesDef({ ...base, turbo, turboLora }) : resourcesDef(base);
    })
    .field('cfgScale', slider(opts.cfgScale, 'cfgScale'))
    .field('steps', slider(opts.steps, 'steps'))
    .effect(
      turbo
        ? {
            resources: (value: unknown, { next }: { next: TurboRuleState }) => {
              if (!Array.isArray(value)) return;
              const active = activeTurboLora(value, turbo.lora, next.turboLora);
              return active && active.id !== next.turboLora?.id ? { turboLora: active } : undefined;
            },
            model: (
              model: unknown,
              {
                patch,
                state,
                next,
              }: {
                patch: Readonly<Record<string, unknown>>;
                state: TurboRuleState;
                next: TurboRuleState;
              }
            ) => {
              const resources = next.resources;
              if ('resources' in patch || !Array.isArray(resources)) return;
              // A pick equal to the old checkpoint's default is treated as toggle-added.
              const old = state.turboLora;
              if (!old || old.id !== defaultTurboLora(turbo, state.model).id) return;
              const active = activeTurboLora(resources, turbo.lora, old);
              if (!active || active.id !== old.id) return;
              const fresh = defaultTurboLora(turbo, model);
              if (fresh.id === active.id) return;
              const rest = resources.filter((r) => r !== active);
              const present = rest.some((r) => (r as ResourceData).id === fresh.id);
              return { resources: present ? rest : [...rest, fresh] };
            },
          }
        : {}
    );
}
