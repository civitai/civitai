import { z } from 'zod';
import { defineGraph } from 'form-graph';
import { MAX_NEGATIVE_PROMPT_LENGTH } from '~/shared/data-graph/generation/common';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import {
  SNIPPETS,
  textDef,
  type ImageEntry,
  type ResourceData,
  type SnippetsValue,
} from './defs';

/** Hub facts every video family reads: what the outer graph already resolved. */
export type VideoHubCtx = { workflow: string; ecosystem: string };

/** Everything upstream of a family graph: the generation ctx plus hub ctx. */
export type VideoExt = GenerationCtx & VideoHubCtx;

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
export type TextBlockNeeds = VideoExt & {
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
     * Whether the negative prompt is a TEXT EDITOR (createTextEditorGraph) and
     * so registers itself as a snippet target, or a plain node that does not.
     * Wan 2.7 uses a plain `negativePromptNode()`, so its snippets carry only
     * the prompt target — the differential suite pins the difference.
     */
    negativePromptIsEditor?: boolean;
  } = {}
) {
  const { negativePrompt = true, negativePromptIsEditor = true } = opts;
  const hasNegative = (ext: TextBlockNeeds) =>
    typeof negativePrompt === 'function' ? negativePrompt(ext) : negativePrompt;
  // The editor set drives snippets.targets registration; a graph without a
  // negative prompt must not register one.
  const editorsFor = (ext: TextBlockNeeds) =>
    hasNegative(ext) && negativePromptIsEditor
      ? (['prompt', 'negativePrompt'] as const)
      : (['prompt'] as const);

  return defineGraph<TextBlockNeeds>()
    .computed('triggerWords', ({ _ext }) => {
      const resources = _ext.resources ?? [];
      const all = _ext.model ? [_ext.model, ...resources] : resources;
      return all.flatMap((r) => r.trainedWords ?? []);
    })
    .field('snippets', ({ _ext }) =>
      _ext.flags?.wildcards
        ? {
            ...SNIPPETS,
            default: withTargets(SNIPPETS.default as SnippetsValue, editorsFor(_ext)),
            coerce: (raw: unknown) => withTargets(raw as SnippetsValue, editorsFor(_ext)),
          }
        : null
    )
    .field('prompt', ({ _ext }) => {
      const required = !_ext.images?.length;
      const base = textDef('prompt');
      return required
        ? {
            ...base,
            output: (base.output as z.ZodType<string>).refine((v) => v.trim().length > 0, {
              message: 'Prompt is required',
            }),
          }
        : base;
    })
    .field('negativePrompt', ({ _ext }) =>
      hasNegative(_ext) ? textDef('negativePrompt', MAX_NEGATIVE_PROMPT_LENGTH) : null
    );
}

/** The common case: prompt + negative prompt. */
export const textBlock = makeTextBlock();
