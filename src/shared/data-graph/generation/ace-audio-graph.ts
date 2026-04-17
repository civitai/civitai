/**
 * ACE Audio Audio Graph
 *
 * Controls for ACE Audio 1.5 music generation ecosystem.
 * Supports txt2music workflow — generates music from text description and structured lyrics.
 *
 * Cover Image Modes:
 * - generateCover=true: Multi-step workflow (imageGen → aceStepAudio with $ref to generated cover)
 * - images provided: Single-step aceStepAudio with user-supplied cover image URL
 * - Neither: Single-step aceStepAudio with no cover, output type is 'audio'
 *
 * Nodes:
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
import { seedNode, imagesNode } from './common';

// =============================================================================
// Constants
// =============================================================================

/** ACE Audio duration range */
const ACE_AUDIO_MIN_DURATION = 1;
const ACE_AUDIO_MAX_DURATION = 190;
const ACE_AUDIO_DEFAULT_DURATION = 60;

/** ACE Audio BPM range */
const ACE_AUDIO_MIN_BPM = 40;
const ACE_AUDIO_MAX_BPM = 200;
const ACE_AUDIO_DEFAULT_BPM = 120;

// =============================================================================
// ACE Audio Graph
// =============================================================================

/** Context shape for ace-audio graph */
type AceAudioCtx = { ecosystem: string; workflow: string };

const MAX_DESCRIPTION_LENGTH = 1000;

export const aceAudioGraph = new DataGraph<AceAudioCtx, GenerationCtx>()
  // Music description — style, genre, mood, instruments, etc.
  .node('musicDescription', {
    input: z.string().optional(),
    output: z.string().trim().max(MAX_DESCRIPTION_LENGTH, 'Description is too long').nonempty('Music description is required'),
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
  });

// Export constants for use in components
export {
  ACE_AUDIO_MIN_DURATION,
  ACE_AUDIO_MAX_DURATION,
  ACE_AUDIO_DEFAULT_DURATION,
  ACE_AUDIO_MIN_BPM,
  ACE_AUDIO_MAX_BPM,
  ACE_AUDIO_DEFAULT_BPM,
};
