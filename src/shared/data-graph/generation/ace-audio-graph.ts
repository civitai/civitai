/**
 * ACE Audio Audio Graph
 *
 * Controls for ACE Audio 1.5 music generation ecosystem.
 * Supports txt2music workflow — generates music from text description and structured lyrics.
 *
 * Modes (top-level discriminator on `aceAudioMode`):
 * - simple: User provides a prompt + duration. Handler emits a chatCompletion step that
 *   produces lyrics/musicDescription/bpm/key, then references those in aceStepAudio.
 * - custom: Full control surface — adds lyrics, musicDescription, cfg, steps, bpm, weights.
 *
 * Shared nodes (parent level — visible in both modes):
 * - aceAudioMode: tabs picker (simple | custom)
 * - model: Version selector (5 options)
 * - generateCover: Toggle to auto-generate a cover image via Flux2 Klein
 * - images: Optional cover image (hidden when generateCover is true)
 * - seed: Optional seed for reproducibility
 * - duration: Audio duration in seconds
 *
 * Custom-only nodes (in the custom subgraph):
 * - cfgScale, steps: Variant-dependent (different defaults per turbo/base, range differs for steps)
 * - title: Display-only label for the generated track (not used in generation)
 * - musicDescription: Music style/genre description
 * - lyrics: Structured lyrics input
 * - bpm: Beats per minute
 * - instrumentalWeight: Instrumental element weight
 * - vocalWeight: Vocal element weight
 *
 * Five model versions discriminated by aceAudioVariant (computed from model.id):
 * - turbo (v1.5 XL Turbo, v1.5 Turbo): cfgScale 1, steps 8, range 1-20
 * - base (v1.5 XL SFT, v1.5 XL Base, v1.5 Base): cfgScale 4, steps 50, range 1-100
 *
 * Cover Image Modes (handler):
 * - generateCover=true: Multi-step (imageGen → aceStepAudio with $ref to generated cover)
 * - images provided: Single-step aceStepAudio with user-supplied cover image URL
 * - Neither: Single-step aceStepAudio with no cover, output type is 'audio'
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import type { ResourceData } from './common';
import {
  createCheckpointGraph,
  createTextEditorGraph,
  imagesNode,
  seedNode,
  sliderNode,
  triggerWordsGraph,
} from './common';

// =============================================================================
// Constants
// =============================================================================

/** ACE Audio mode type */
export type AceAudioMode = 'simple' | 'custom';

/** ACE Audio mode options (used by the tabs picker in the UI) */
const aceAudioModeOptions = [
  { label: 'Simple', value: 'simple' as const },
  { label: 'Custom', value: 'custom' as const },
];

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
// Subgraph context
// =============================================================================

/**
 * Context shape inherited by ace-audio mode subgraphs. Both modes share
 * model, generateCover, images, seed, and duration — defined at the parent
 * level before the discriminator.
 */
type AceAudioModeCtx = {
  ecosystem: string;
  workflow: string;
  aceAudioMode: AceAudioMode;
  model: ResourceData;
};

// =============================================================================
// Simple Mode Subgraph
// =============================================================================

/**
 * Simple mode adds the prompt editor — the user's input drives the chatCompletion
 * step in the handler. Custom mode does not include prompt (uses musicDescription
 * instead). Override placeholder/info so the form makes the chatCompletion role
 * obvious to the user.
 */
const aceAudioSimpleGraph = new DataGraph<AceAudioModeCtx, GenerationCtx>().merge(
  createTextEditorGraph({
    name: 'prompt',
    required: true,
    placeholder: 'Describe the song you want to generate...',
    info: 'In simple mode, your prompt is sent to a chat model that drafts the lyrics, music description, BPM, and key for you. Describe the song concept in plain English.',
  })
);

// =============================================================================
// Custom Mode Subgraph (full controls)
// =============================================================================

const aceAudioCustomGraph = new DataGraph<AceAudioModeCtx, GenerationCtx>()
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
  // Delivered via the text-editor factory so it carries snippet-target metadata
  // and stays consistent with prompt/negativePrompt/lyrics editors.
  .merge(
    () =>
      createTextEditorGraph({
        name: 'musicDescription',
        required: true,
        emptyMessage: 'Music description is required',
        maxLength: MAX_DESCRIPTION_LENGTH,
      }),
    []
  )

  // Lyrics — structured input with section markers like [Verse], [Chorus], etc.
  .merge(
    () =>
      createTextEditorGraph({
        name: 'lyrics',
        required: false,
      }),
    []
  )

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

// =============================================================================
// ACE Audio Graph (top-level)
// =============================================================================

/** Context shape for ace-audio graph */
type AceAudioCtx = { ecosystem: string; workflow: string };

export const aceAudioGraph = new DataGraph<AceAudioCtx, GenerationCtx>()
  // Model version selector — shared by both modes
  .merge(
    () =>
      createCheckpointGraph({
        versions: { options: aceAudioVersionOptions },
        defaultModelId: aceAudioVersionIds.xlTurbo,
      }),
    []
  )

  // triggerWords — derived from the model's trainedWords. Placed before the
  // discriminator so both simple- and custom-mode editors see it in ctx.
  .merge(triggerWordsGraph)

  // Generate-cover toggle — shared by both modes
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

  // Seed — shared by both modes
  .node('seed', seedNode())

  // Duration — shared by both modes
  .node('duration', {
    input: z.coerce.number().optional(),
    output: z.number().min(ACE_AUDIO_MIN_DURATION).max(ACE_AUDIO_MAX_DURATION),
    defaultValue: ACE_AUDIO_DEFAULT_DURATION,
    meta: {
      min: ACE_AUDIO_MIN_DURATION,
      max: ACE_AUDIO_MAX_DURATION,
    },
  })

  // Mode selector — surfaced as tabs in the UI (simple | custom)
  .node('aceAudioMode', {
    input: z.enum(['simple', 'custom']).optional(),
    output: z.enum(['simple', 'custom']),
    defaultValue: 'simple',
    meta: {
      options: aceAudioModeOptions,
    },
  })

  // Discriminate subgraph by mode
  .discriminator('aceAudioMode', {
    simple: aceAudioSimpleGraph,
    custom: aceAudioCustomGraph,
  });

// Export constants for use in components
export {
  ACE_AUDIO_MIN_DURATION,
  ACE_AUDIO_MAX_DURATION,
  ACE_AUDIO_DEFAULT_DURATION,
  ACE_AUDIO_MIN_BPM,
  ACE_AUDIO_MAX_BPM,
  ACE_AUDIO_DEFAULT_BPM,
  aceAudioModeOptions,
};
