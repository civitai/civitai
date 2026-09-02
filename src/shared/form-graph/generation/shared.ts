import { defineGraph, rootScope, type Scope } from 'form-graph';
import { getEcosystemGroupByKey } from '~/shared/constants/basemodel.constants';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import {
  MAX_NEGATIVE_PROMPT_LENGTH,
  SNIPPETS,
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
 * The tail every video family shares, transcribed from common.ts's
 * `triggerWordsGraph` + `snippetsGraph` + `promptGraph` + `negativePromptGraph`
 * merge sequence. It is an ordinary graph: its `Ext` names what it needs from
 * whatever mounts it, so `.use(textBlock)` satisfies those from the parent's
 * fields (model/resources/images) plus the parent's ext.
 *
 * Ordering matches common.ts's documented merge order (triggerWords →
 * snippets → editors), because the editors read both off ctx.
 */
export type TextBlockNeeds = FamilyExt & {
  model?: ResourceData;
  resources?: ResourceData[];
  images?: ImageEntry[];
};

/**
 * `snippets.targets` registration: in data-graph each text editor announces
 * itself through an effect that writes an empty target slice. The editor set of
 * a given graph is static, so the port bakes the same result into the value
 * rather than converging on it — same output, no evaluation-order dependence.
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
     * Whether the negative prompt is a TEXT EDITOR (createTextEditorGraph) —
     * live triggerWords + a snippets slice in meta — or a plain node with
     * neither (wan 2.7's `negativePromptNode()`).
     */
    negativePromptIsEditor?: boolean;
    /**
     * Whether that editor also REGISTERS itself in `snippets.targets`.
     * Defaults to `negativePromptIsEditor`; zimage Base's editor sits inside
     * a v1 mode subgraph where registration never fires, so it is an editor
     * that does NOT register — the differential pins its targets as
     * `{ prompt }` alone.
     */
    negativePromptRegistersTarget?: boolean;
    /** hi-dream-o1 omits v1's snippetsGraph entirely — no snippets key at all. */
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
    // v1 stores the text block globally — detach from whatever family
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
              coerce: (raw: unknown) => withTargets(raw as SnippetsValue, editorsFor(_ext)),
            }
          : null
      )
      // The editors read triggerWords/snippets from the BAG — they are this
      // graph's own fields, declared above. Meta mirrors v1's textNode contract:
      // the snippets slice's PRESENCE doubles as the wildcards feature flag.
      .field('prompt', ({ triggerWords, snippets, _ext }) => {
        const required = promptAlwaysRequired || !_ext.images?.length;
        const base = textDef('prompt');
        return {
          ...base,
          output: required
            ? base.output.refine((v) => v.trim().length > 0, { message: 'Prompt is required' })
            : base.output,
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
        // not track trigger words — v1's negativePromptNode vs negativePromptGraph
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
 * The per-family persistence bucket (v1's ecosystem/group storage group):
 * grouped ecosystems (wan versions, klein variants) share their group id so
 * settings survive version switches; standalone ecosystems get their own key.
 * Family graphs attach it with `defineGraph({ scope: familyScope })`.
 */
export function familyScope(ext: { ecosystem: string }): Scope {
  return getEcosystemGroupByKey(ext.ecosystem)?.id ?? ext.ecosystem;
}

/**
 * v1's turbo-variant refinement: ecosystems that ship distilled and base
 * builds with different slider ranges store cfgScale/steps per MODEL VERSION,
 * so switching variants doesn't clamp values one-way.
 */
export function perModelScope(ext: { model?: unknown }): Scope | undefined {
  const id = modelIdOf(ext.model);
  // a RELATIVE segment: appended to the family bucket the graph inherits,
  // yielding v1's ['ecosystem', 'model.id'] address; no model -> inherit as-is
  return id != null ? [id] : undefined;
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
 * builder for the graphs AND the handlers, so the two lanes cannot drift on
 * which ids map to which mode.
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
