/**
 * Sora Graph
 *
 * Controls for OpenAI Sora 2 video generation ecosystem.
 * Supports txt2vid and img2vid workflows.
 *
 * Nodes:
 * - seed: Optional seed for reproducibility
 * - aspectRatio: Output aspect ratio (16:9 or 9:16)
 * - resolution: Output resolution (720p or 1080p)
 * - usePro: Toggle for pro mode (higher quality)
 * - duration: Video duration (4 or 8 seconds)
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { seedNode, aspectRatioNode, createCheckpointGraph } from './common';

// =============================================================================
// Constants
// =============================================================================

/** Sora aspect ratio options */
const soraAspectRatios = [
  { label: '16:9', value: '16:9', width: 1920, height: 1080 },
  { label: '9:16', value: '9:16', width: 1080, height: 1920 },
];

/** Sora resolution options */
const soraResolutions = [
  { label: '720p', value: '720p' },
  { label: '1080p', value: '1080p' },
];

/** Sora duration options */
const soraDurations = [
  { label: '4 seconds', value: 4 },
  { label: '8 seconds', value: 8 },
];

// =============================================================================
// Sora Graph
// =============================================================================

/** Context shape for sora graph */
type SoraCtx = { ecosystem: string; workflow: string };

/**
 * Sora 2 video generation controls.
 *
 * Workflow-specific behavior:
 * - txt2vid: Shows aspect ratio selector
 * - img2vid: Aspect ratio derived from source image
 */
export const soraGraph = new DataGraph<SoraCtx, GenerationCtx>()
  // Merge checkpoint graph (model node with locked model from ecosystem settings)
  .merge(createCheckpointGraph())

  // Seed node
  .node('seed', seedNode())

  // Aspect ratio node - only for txt2vid workflow
  .node(
    'aspectRatio',
    (ctx) => ({
      ...aspectRatioNode({ options: soraAspectRatios, defaultValue: '9:16' }),
      when: ctx.workflow === 'txt2vid',
    }),
    ['workflow']
  )

  // Resolution node
  .node('resolution', {
    input: z.enum(['720p', '1080p']).optional(),
    output: z.enum(['720p', '1080p']),
    defaultValue: '720p' as const,
    meta: { options: soraResolutions },
  })

  // Pro mode toggle
  .node('usePro', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })

  // Duration node
  .node('duration', {
    input: z.coerce.number().optional(),
    output: z.number(),
    defaultValue: 4,
    meta: { options: soraDurations },
  });

// Export constants for use in components
export { soraAspectRatios, soraResolutions, soraDurations };
