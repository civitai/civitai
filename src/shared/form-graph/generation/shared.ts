import { z } from 'zod';
import { cachedFactory, defineGraph, rootScope, type Scope } from 'form-graph';
import { ecosystemByKey, getEcosystemGroupByKey } from '~/shared/constants/basemodel.constants';
import { resolveCompatibleEcosystem } from './ecosystem-gates';

import type { GenerationCtx } from '~/shared/generation/context';
import {
  MAX_NEGATIVE_PROMPT_LENGTH,
  SNIPPETS,
  snippetsSchema,
  resourcesDef,
  sliderDef,
  textDef,
  type ImageEntry,
  type ResourceData,
  type SnippetsValue,
} from './defs';

/** What the root resolved before dispatching to a per-output-type hub. */
export type RootCtx = GenerationCtx & {
  workflow: string;
  output: 'image' | 'video' | 'audio' | 'model3d';
  input: 'text' | 'image' | 'video';
};

/** Hub facts every family reads: what the outer graphs already resolved. */
export type HubCtx = { workflow: string; ecosystem: string };

/** Everything upstream of a family graph: the generation ctx plus hub ctx. */
export type FamilyExt = GenerationCtx & HubCtx;

/**
 * The tail every video family shares — trigger words, snippets, prompt, negative
 * prompt. It is an ordinary graph: its `Ext` names what it needs from
 * whatever mounts it, so `.use(textBlock)` satisfies those from the parent's
 * fields (model/resources/images) plus the parent's ext.
 *
 * Merge order is load-bearing (triggerWords → snippets → editors): the editors read
 * the first two off ctx.
 */
export type TextBlockNeeds = FamilyExt & {
  model?: ResourceData;
  resources?: ResourceData[];
  images?: ImageEntry[];
};

/**
 * `snippets.targets` registration: every text editor a graph has gets an empty target
 * slice. The editor set is static per graph, so it is baked into the value rather than
 * converged on — no evaluation-order dependence.
 *
 * It has to be baked on BOTH paths. `coerce` covers trusted `set()` writes only — the
 * lib says so — so with `coerce` alone a parse that SUPPLIED a snippets value kept
 * whatever targets the caller sent and registered no editors at all. Pinned by
 * `snippets-targets.test.ts`.
 */
const withTargets = (value: SnippetsValue, names: readonly string[]): SnippetsValue => {
  const targets = { ...(value.targets ?? {}) };
  let changed = false;
  for (const name of names) {
    if (!(name in targets)) {
      targets[name] = [];
      changed = true;
    }
  }
  return changed ? { ...value, targets } : value;
};

/**
 * The tail is parameterised because the families differ on the negative
 * prompt: LTX and most Wan versions always have one, Wan 2.1 has none, and
 * Wan 2.7 drops it on edit-video. `negativePrompt` takes a boolean or a
 * predicate over the ext.
 */
export function makeTextBlock(
  opts: {
    negativePrompt?: boolean | ((ext: TextBlockNeeds) => boolean);
    /**
     * Whether the negative prompt is a TEXT EDITOR —
     * live triggerWords + a snippets slice in meta — or a plain node with
     * neither (wan 2.7's `negativePromptNode()`).
     */
    negativePromptIsEditor?: boolean;
    /**
     * Whether that editor also REGISTERS itself in `snippets.targets`.
     * Defaults to `negativePromptIsEditor`. zimage Base is the one editor that must
     * NOT register — targets stay `{ prompt }` alone, pinned by `snippets-targets.test.ts`.
     */
    negativePromptRegistersTarget?: boolean;
    /** hi-dream-o1 has no snippets key at all. */
    snippets?: boolean;
    /** wan-image caps its negative editor at 500 chars, not the shared 6000. */
    negativePromptMaxLength?: number;
    /** grok requires a prompt on every workflow, staged images included. */
    promptAlwaysRequired?: boolean;
  } = {}
) {
  const {
    negativePrompt = true,
    negativePromptIsEditor = true,
    negativePromptRegistersTarget = negativePromptIsEditor,
    snippets: hasSnippets = true,
    negativePromptMaxLength = MAX_NEGATIVE_PROMPT_LENGTH,
    promptAlwaysRequired = false,
  } = opts;
  const hasNegative = (ext: TextBlockNeeds) =>
    typeof negativePrompt === 'function' ? negativePrompt(ext) : negativePrompt;
  // The editor set drives snippets.targets registration; a graph without a
  // negative prompt must not register one.
  const editorsFor = (ext: TextBlockNeeds) =>
    hasNegative(ext) && negativePromptRegistersTarget
      ? (['prompt', 'negativePrompt'] as const)
      : (['prompt'] as const);

  return (
    // The text block is stored globally — detach from whatever family
    // bucket this mounts under
    defineGraph<TextBlockNeeds>({ scope: () => rootScope() })
      .computed('triggerWords', ({ _ext }) => {
        const resources = _ext.resources ?? [];
        const all = _ext.model ? [_ext.model, ...resources] : resources;
        return all.flatMap((r) => r.trainedWords ?? []);
      })
      .field('snippets', ({ _ext }) =>
        hasSnippets && _ext.flags?.wildcards
          ? {
              ...SNIPPETS,
              default: withTargets(SNIPPETS.default as SnippetsValue, editorsFor(_ext)),
              input: snippetsSchema
                .optional()
                .transform((v) => (v ? withTargets(v, editorsFor(_ext)) : v)),
              coerce: (raw: unknown) => withTargets(raw as SnippetsValue, editorsFor(_ext)),
            }
          : null
      )
      // The editors read triggerWords/snippets from the BAG — they are this
      // graph's own fields, declared above. Meta is the text-field contract:
      // the snippets slice's PRESENCE doubles as the wildcards feature flag.
      .field('prompt', ({ triggerWords, snippets, _ext }) => {
        const required = promptAlwaysRequired || !_ext.images?.length;
        return {
          ...textDef('prompt'),
          refine: required
            ? (output: z.ZodString) =>
                output.refine((v) => v.trim().length > 0, { message: 'Prompt is required' })
            : undefined,
          meta: {
            required,
            targetKey: 'prompt',
            snippets: snippets ? snippets.targets?.['prompt'] ?? [] : undefined,
            triggerWords,
          },
        };
      })
      .field('negativePrompt', ({ triggerWords, snippets, _ext }) => {
        if (!hasNegative(_ext)) return null;
        const base = textDef('negativePrompt', negativePromptMaxLength);
        // a plain (non-editor) negative prompt is not a snippet target and does
        // not track trigger words
        return {
          ...base,
          meta: {
            required: false,
            targetKey: 'negativePrompt',
            snippets:
              negativePromptIsEditor && snippets
                ? snippets.targets?.['negativePrompt'] ?? []
                : undefined,
            triggerWords: negativePromptIsEditor ? triggerWords : [],
          },
        };
      })
  );
}

/**
 * The per-family persistence bucket:
 * grouped ecosystems (wan versions, klein variants) share their group id so
 * settings survive version switches; standalone ecosystems get their own key.
 * Family graphs attach it with `defineGraph({ scope: familyScope })`.
 */
export function familyScope(ext: { ecosystem: string }): Scope {
  return getEcosystemGroupByKey(ext.ecosystem)?.id ?? ext.ecosystem;
}

/**
 * The turbo-variant refinement: ecosystems that ship distilled and base
 * builds with different slider ranges store cfgScale/steps per MODEL VERSION,
 * so switching variants doesn't clamp values one-way.
 */
export function perModelScope(ext: { model?: unknown }): Scope | undefined {
  const id = modelIdOf(ext.model);
  // a RELATIVE segment: appended to the family bucket the graph inherits,
  // yielding an ['ecosystem', 'model.id'] address; no model -> inherit as-is
  return id != null ? [id] : undefined;
}

/**
 * Runtime-checked narrowing for a multi-ecosystem family's `effectiveEcosystem`
 * emit: the value is one of the family's served keys, typed as their literal
 * union so `GenerationData` discriminates per arm. The fallback can only fire
 * if an unserved ecosystem reached the family — the hub dispatch prevents it.
 */
export function narrowEcosystem<const E extends readonly string[]>(
  served: E,
  value: string
): E[number] {
  return (served.includes(value) ? value : served[0]) as E[number];
}

/**
 * A model's version id from either shape it takes in ctx: the STORE keeps the
 * raw input (a bare number from remix/deep-link), parse normalizes to an
 * object — mode picks and scopes must read both.
 */
export function modelIdOf(model: unknown): number | undefined {
  if (typeof model === 'number') return model;
  if (model && typeof model === 'object') return (model as { id?: number }).id;
  return undefined;
}

/** The standard family resources field: this ecosystem, the ctx limit. */
export const familyResources = ({ _ext }: { _ext: FamilyExt }) =>
  resourcesDef({ ecosystem: _ext.ecosystem, limit: _ext.limits.maxResources });

/**
 * A slider remembered per MODEL VERSION (the turbo-variant refinement) — the
 * one shape every distilled/base family repeats for cfgScale/steps.
 */
export function perModelSlider(opts: Parameters<typeof sliderDef>[0]) {
  return ({ _ext }: { _ext: { ecosystem: string; model?: unknown } }) => ({
    ...sliderDef(opts),
    scope: perModelScope(_ext),
  });
}

/**
 * Version-id → mode lookup, input-tolerant (bare number or object). One
 * builder for the graphs AND the handlers, so the client graph and the server
 * handler cannot drift on which ids map to which mode.
 */
export function versionModeOf<M extends string>(
  ids: Record<M, number>,
  fallback: NoInfer<M> | ((ext: { workflow: string }) => NoInfer<M>)
): (model: unknown, ext?: { workflow: string }) => M {
  const byId = new Map<number, M>(
    (Object.entries(ids) as [M, number][]).map(([mode, id]) => [id, mode])
  );
  return (model, ext) => {
    const id = modelIdOf(model);
    const hit = id != null ? byId.get(id) : undefined;
    if (hit) return hit;
    return typeof fallback === 'function' ? fallback(ext ?? { workflow: '' }) : fallback;
  };
}

/** The common case: prompt + negative prompt. */
export const textBlock = makeTextBlock();
export const promptOnlyTextBlock = makeTextBlock({ negativePrompt: false });

/**
 * The per-output hubs' `ecosystem` field schemas, memoized on what they
 * actually depend on — the workflow (`correct` redirects unsupported
 * selections) and the hidden/disabled/usable sets (the output refuses the
 * first two, `correct` redirects into the third). Unmemoized these rebuilt
 * every pass, the single hottest schema on the keystroke path. Meta and the
 * default stay per-pass at the call site.
 */
export const ecosystemFieldSchemas = cachedFactory(function ecosystemFieldSchemas(
  workflow: string,
  hiddenEcosystems: readonly string[],
  disabledKeys: readonly string[],
  usableEcosystems: readonly string[]
) {
  const hiddenSet = new Set(hiddenEcosystems);
  const disabledSet = new Set(disabledKeys);
  return {
    input: z
      .string()
      .optional()
      .transform((v) => {
        if (!v) return undefined;
        // Hidden values are dropped at the boundary so a stale stored value
        // falls back to the default; disabled/memberOnly are kept so the
        // picker can explain them, and refused on output. An unknown key
        // would have no member graph — it falls to the default too.
        if (!ecosystemByKey.has(v) || hiddenSet.has(v)) return undefined;
        return v;
      }),
    output:
      hiddenSet.size || disabledSet.size
        ? z.string().refine((v) => !hiddenSet.has(v) && !disabledSet.has(v), {
            message: 'Ecosystem is currently unavailable',
          })
        : z.string(),
    // This used to be an effect keyed on `workflow`, so a one-shot parse that
    // supplied `ecosystem` without `workflow` skipped it and failed validation
    // instead. On the field it runs whatever the caller sent.
    correct: (value: string) => {
      const target = resolveCompatibleEcosystem(workflow, value, usableEcosystems);
      return target === value
        ? undefined
        : { value: target, reason: 'ecosystem_workflow_unavailable' };
    },
  };
});
