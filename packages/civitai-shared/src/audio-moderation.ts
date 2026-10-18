import { z } from 'zod';

const scannedAudio = z
  .object({
    lyrics: z.string(),
    sexualizedMinors: z.boolean(),
    blocked: z.boolean(),
    score: z.number().finite().min(0).max(1),
    model: z.string().min(1),
    policyHash: z.string().min(1),
    hasAudio: z.literal(true),
    skippedReason: z.null().optional(),
  })
  .refine((result) => result.blocked === result.sexualizedMinors, 'Inconsistent verdict');

const noAudio = z.object({
  lyrics: z.literal(''),
  sexualizedMinors: z.literal(false),
  blocked: z.literal(false),
  hasAudio: z.literal(false),
  skippedReason: z.literal('noAudioTrack'),
  score: z.null().optional(),
  model: z.null().optional(),
  policyHash: z.null().optional(),
});

export const audioModerationResultSchema = z.union([scannedAudio, noAudio]);
export type AudioModerationResult = z.infer<typeof audioModerationResultSchema>;
