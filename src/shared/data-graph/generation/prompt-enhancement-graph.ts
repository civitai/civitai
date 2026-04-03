/**
 * Prompt Enhancement Graph
 *
 * Empty graph for the prompt:enhance workflow.
 * This workflow doesn't use the generation graph system — the UI is fully
 * self-contained in PromptEnhancePanel. This graph only exists to satisfy
 * the groupedDiscriminator requirement that every workflow value maps to a branch.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';

export const promptEnhancementGraph = new DataGraph<Record<never, never>, GenerationCtx>();
