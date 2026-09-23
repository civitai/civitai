import { defineGraph } from 'form-graph';
import { grokVersionIds } from '~/shared/data-graph/generation/version-ids';
import { checkpointDef } from './checkpoint';
import { SEED } from './defs';
import { makeTextBlock, type FamilyExt } from './shared';

/**
 * The pieces shared by Grok's two hub arms — `image/grok.graph.ts` and
 * `video/grok.graph.ts`. Grok is the one family serving BOTH output types
 * from a single ecosystem (v1 splits on the root's `output` computed), so
 * the version-locked head and the always-required text block live here
 * rather than in either hub's folder.
 */

export const grokVersionOptions = [
  { label: 'v1.0', value: grokVersionIds['v1.0'] },
  { label: 'v1.5', value: grokVersionIds['v1.5'] },
  { label: 'v2.0', value: grokVersionIds['v2.0'] },
];

export const isGrokV15 = (modelId?: number) => modelId === grokVersionIds['v1.5'];
export const isGrokV2 = (modelId?: number) => modelId === grokVersionIds['v2.0'];

type GrokExt = FamilyExt & { model?: unknown };

/** The shared head both halves mount: version-locked model + seed. */
export const grokHead = defineGraph<GrokExt>()
  .field('model', ({ _ext }) =>
    checkpointDef({
      ecosystem: _ext.ecosystem,
      workflow: _ext.workflow,
      ext: _ext,
      versions: { options: grokVersionOptions },
    })
  )
  .field('seed', SEED);

/** Grok is text-driven on every workflow — prompt required, no negative. */
export const grokTextBlock = makeTextBlock({ negativePrompt: false, promptAlwaysRequired: true });
