/**
 * MiniMax (Hailuo) Graph
 *
 * Controls for MiniMax Hailuo video generation ecosystem.
 * Supports txt2vid and img2vid workflows.
 *
 * Simple configuration - only requires:
 * - enablePromptEnhancer: Toggle for prompt enhancement
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';

// =============================================================================
// MiniMax Graph
// =============================================================================

/** Context shape for minimax graph */
type MiniMaxCtx = { baseModel: string; workflow: string };

/**
 * MiniMax (Hailuo) video generation controls.
 *
 * Minimal configuration - the model handles most parameters automatically.
 */
export const minimaxGraph = new DataGraph<MiniMaxCtx, GenerationCtx>()
  // Prompt enhancer toggle
  .node('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  });
