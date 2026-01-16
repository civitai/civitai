/**
 * Mochi Graph
 *
 * Controls for Mochi video generation ecosystem.
 * Supports txt2vid workflow only (no img2vid support).
 *
 * Very simple configuration:
 * - seed: Optional seed for reproducibility
 * - enablePromptEnhancer: Toggle for prompt enhancement
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { seedNode } from './common';

// =============================================================================
// Mochi Graph
// =============================================================================

/** Context shape for mochi graph */
type MochiCtx = { baseModel: string; workflow: string };

/**
 * Mochi video generation controls.
 *
 * Txt2vid only with minimal configuration.
 * Mochi 1 preview by Genmo - state-of-the-art open video generation.
 */
export const mochiGraph = new DataGraph<MochiCtx, GenerationCtx>()
  // Seed node
  .node('seed', seedNode())

  // Prompt enhancer toggle
  .node('enablePromptEnhancer', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  });
