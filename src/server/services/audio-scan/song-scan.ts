import type { Priority, WorkflowStepTemplate } from '@civitai/orchestration-client';
import { z } from 'zod';
import type { LyricLine, TranscribedWord } from '~/server/services/audio-scan/lyric-alignment';
import type { AudioScanParse } from '~/server/services/video-audio-scan.service';

const TRANSCRIBE_STEP = 'transcribe';

/**
 * Whether a song's audio is transcribed when it is scanned. Always: lyrics and times the client sent
 * are never taken on trust, so they cannot stand in for checking what is actually sung. This is the
 * one place the policy lives.
 */
export function shouldTranscribe(_lyrics: LyricLine[] | undefined) {
  return true;
}

/**
 * The steps that scan one song. The verdict comes from `audioModeration`, the step the video scan
 * already runs. The transcription is its own step with no `$ref` between them: it only supplies word
 * times for the lyrics, so its failure or empty timestamps must never stand between the song and its
 * verdict.
 */
export function buildSongScanSteps({
  mediaUrl,
  lyrics,
  metadata,
  priority,
}: {
  mediaUrl: string;
  lyrics: LyricLine[] | undefined;
  metadata: Record<string, unknown>;
  priority?: Priority;
}) {
  const steps = [
    ...(shouldTranscribe(lyrics)
      ? [
          {
            $type: 'transcription',
            name: TRANSCRIBE_STEP,
            metadata,
            priority,
            input: { mediaUrl, returnTimeStamps: true },
          },
        ]
      : []),
    {
      $type: 'audioModeration',
      name: 'audio',
      metadata,
      priority,
      input: { mediaUrl, transcriber: 'auto' },
    },
  ];
  // The client's step types predate these steps.
  return steps as unknown as WorkflowStepTemplate[];
}

const transcriptionOutput = z.object({
  timeStamps: z.array(
    z.object({ text: z.string(), startTime: z.number().finite(), endTime: z.number().finite() })
  ),
});

/** The word timestamps of a finished workflow's transcription step; nothing when it has none. */
export function readTranscriptionWords(
  steps: readonly { $type?: string; status?: string; output?: unknown }[]
): TranscribedWord[] {
  const step = steps.find((candidate) => candidate.$type === 'transcription');
  if (step?.status && step.status !== 'succeeded') return [];
  const parsed = transcriptionOutput.safeParse(step?.output);
  return parsed.success ? parsed.data.timeStamps : [];
}

export type SongVerdict =
  | { action: 'block' }
  | { action: 'clean' }
  | { action: 'retry'; reason: string };

/**
 * What a finished song scan means for the song. A scan that produced no usable result is never a
 * pass. "No audio" with no stored lyrics is an instrumental, which has nothing to flag; with stored
 * lyrics the scan was handed text it should have read, so that is a failure.
 */
export function songVerdict(parsed: AudioScanParse, hasStoredLyrics: boolean): SongVerdict {
  if (!parsed.ok) return { action: 'retry', reason: parsed.error };
  if (!parsed.hasAudio)
    return hasStoredLyrics
      ? { action: 'retry', reason: 'scan reported no audio for a song with lyrics' }
      : { action: 'clean' };
  return parsed.flagged ? { action: 'block' } : { action: 'clean' };
}
