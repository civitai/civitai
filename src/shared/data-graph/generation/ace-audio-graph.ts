/**
 * ACE Audio Audio Graph
 *
 * Controls for ACE Audio 1.5 music generation ecosystem.
 * Supports txt2music workflow — generates music from text description and structured lyrics.
 *
 * Five model versions discriminated by aceAudioVariant (computed from model.id):
 * - turbo (v1.5 XL Turbo, v1.5 Turbo): cfgScale 1, steps 8, range 1-20
 * - base (v1.5 XL SFT, v1.5 XL Base, v1.5 Base): cfgScale 4, steps 50, range 1-100
 *
 * Cover Image Modes:
 * - generateCover=true: Multi-step workflow (imageGen → aceStepAudio with $ref to generated cover)
 * - images provided: Single-step aceStepAudio with user-supplied cover image URL
 * - Neither: Single-step aceStepAudio with no cover, output type is 'audio'
 *
 * Nodes:
 * - model: Version selector (5 options)
 * - cfgScale, steps: Variant-dependent (different defaults per turbo/base, range differs for steps)
 * - title: Display-only label for the generated track (not used in generation)
 * - musicDescription: Music style/genre description
 * - seed: Optional seed for reproducibility
 * - generateCover: Toggle to auto-generate a cover image via Flux2 Klein
 * - images: Optional cover image (hidden when generateCover is true)
 * - lyrics: Structured lyrics input
 * - duration: Audio duration in seconds
 * - bpm: Beats per minute
 * - instrumentalWeight: Instrumental element weight
 * - vocalWeight: Vocal element weight
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { ResourceData } from './common';
import { createCheckpointGraph, imagesNode, seedNode, sliderNode } from './common';

// =============================================================================
// Constants
// =============================================================================

/** ACE Audio model version IDs */
export const aceAudioVersionIds = {
  xlTurbo: 2864949,
  turbo: 2864880,
  xlSft: 2864917,
  xlBase: 2864892,
  base: 2864864,
} as const;

type AceAudioVariant = 'turbo' | 'base';

/** Options for ACE Audio version selector (using version IDs as values) */
const aceAudioVersionOptions = [
  { label: 'XL Turbo', value: aceAudioVersionIds.xlTurbo },
  { label: 'Turbo', value: aceAudioVersionIds.turbo },
  { label: 'XL SFT', value: aceAudioVersionIds.xlSft },
  { label: 'XL Base', value: aceAudioVersionIds.xlBase },
  { label: 'Base', value: aceAudioVersionIds.base },
];

/** Map version ID to variant */
const versionIdToVariant = new Map<number, AceAudioVariant>([
  [aceAudioVersionIds.xlTurbo, 'turbo'],
  [aceAudioVersionIds.turbo, 'turbo'],
  [aceAudioVersionIds.xlSft, 'base'],
  [aceAudioVersionIds.xlBase, 'base'],
  [aceAudioVersionIds.base, 'base'],
]);

/** Resolve variant from a model id, defaulting to 'turbo' (matches default model). */
const resolveVariant = (modelId?: number): AceAudioVariant =>
  (modelId ? versionIdToVariant.get(modelId) : undefined) ?? 'turbo';

/** ACE Audio duration range */
const ACE_AUDIO_MIN_DURATION = 1;
const ACE_AUDIO_MAX_DURATION = 190;
const ACE_AUDIO_DEFAULT_DURATION = 60;

/** ACE Audio BPM range */
const ACE_AUDIO_MIN_BPM = 40;
const ACE_AUDIO_MAX_BPM = 200;
const ACE_AUDIO_DEFAULT_BPM = 120;

const MAX_DESCRIPTION_LENGTH = 1000;

// =============================================================================
// ACE Audio Graph
// =============================================================================

/** Context shape for ace-audio graph */
type AceAudioCtx = { ecosystem: string; workflow: string; model: ResourceData };

export const aceAudioGraph = new DataGraph<AceAudioCtx, GenerationCtx>()
  // Model version selector (5 options)
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: aceAudioVersionOptions },
        defaultModelId: aceAudioVersionIds.xlTurbo,
      }),
    []
  )

  // cfgScale — same range, variant-dependent default
  .node(
    'cfgScale',
    (ctx) =>
      sliderNode({
        min: 0.5,
        max: 10,
        defaultValue: resolveVariant(ctx.model?.id) === 'turbo' ? 1 : 4,
        step: 0.5,
      }),
    ['model']
  )

  // steps — variant-dependent range AND default
  .node(
    'steps',
    (ctx) => {
      const isTurbo = resolveVariant(ctx.model?.id) === 'turbo';
      return sliderNode({
        min: 1,
        max: isTurbo ? 20 : 100,
        defaultValue: isTurbo ? 8 : 50,
      });
    },
    ['model']
  )

  // Title — display-only label for the generated track. Not sent to the orchestrator.
  .node('title', {
    input: z.string().optional(),
    output: z.string().trim().max(100, 'Title is too long').optional(),
    defaultValue: '',
  })

  // Music description — style, genre, mood, instruments, etc.
  .node('musicDescription', {
    input: z.string().optional(),
    output: z
      .string()
      .trim()
      .max(MAX_DESCRIPTION_LENGTH, 'Description is too long')
      .nonempty('Music description is required'),
    defaultValue: '',
  })

  // Seed node
  .node('seed', seedNode())

  // Generate cover toggle — when true, an imageGen step is prepended to generate a cover image
  .node('generateCover', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })

  // Optional cover image — hidden when generateCover is true
  .node(
    'images',
    (ctx) => ({
      ...imagesNode({ min: 0, max: 1, aspectRatios: ['1:1'] }),
      when: !('generateCover' in ctx && ctx.generateCover),
    }),
    ['generateCover']
  )

  // Lyrics input — structured lyrics with section markers like [Verse], [Chorus], etc.
  .node('lyrics', {
    input: z.string().optional(),
    output: z.string(),
    defaultValue: '',
  })

  // Duration in seconds (1-190)
  .node('duration', {
    input: z.coerce.number().optional(),
    output: z.number().min(ACE_AUDIO_MIN_DURATION).max(ACE_AUDIO_MAX_DURATION),
    defaultValue: ACE_AUDIO_DEFAULT_DURATION,
    meta: {
      min: ACE_AUDIO_MIN_DURATION,
      max: ACE_AUDIO_MAX_DURATION,
    },
  })

  // BPM (40-200)
  .node('bpm', {
    input: z.coerce.number().optional(),
    output: z.number().min(ACE_AUDIO_MIN_BPM).max(ACE_AUDIO_MAX_BPM),
    defaultValue: ACE_AUDIO_DEFAULT_BPM,
    meta: {
      min: ACE_AUDIO_MIN_BPM,
      max: ACE_AUDIO_MAX_BPM,
    },
  })

  // Instrumental weight (0.0-1.0)
  .node('instrumentalWeight', {
    input: z.coerce.number().optional(),
    output: z.number().min(0).max(1),
    defaultValue: 0.5,
    meta: { min: 0, max: 1, step: 0.1 },
  })

  // Vocal weight (0.0-1.0)
  .node('vocalWeight', {
    input: z.coerce.number().optional(),
    output: z.number().min(0).max(1),
    defaultValue: 0.5,
    meta: { min: 0, max: 1, step: 0.1 },
  })

  // Reset cfgScale and steps to variant defaults when switching models.
  // Without this, a user with steps=80 on a base model would keep steps=80
  // after switching to a turbo variant (max 20) — invalid against the new range.
  .effect(
    (ctx, _ext, set) => {
      const isTurbo = resolveVariant(ctx.model?.id) === 'turbo';
      set('cfgScale', isTurbo ? 1 : 4);
      set('steps', isTurbo ? 8 : 50);
    },
    ['model']
  );

// Export constants for use in components
export {
  ACE_AUDIO_MIN_DURATION,
  ACE_AUDIO_MAX_DURATION,
  ACE_AUDIO_DEFAULT_DURATION,
  ACE_AUDIO_MIN_BPM,
  ACE_AUDIO_MAX_BPM,
  ACE_AUDIO_DEFAULT_BPM,
};
