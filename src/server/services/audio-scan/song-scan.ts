import type { Priority, WorkflowStepTemplate } from '@civitai/orchestration-client';
import { z } from 'zod';
import {
  lyricsAreSynced,
  type LyricLine,
  type TranscribedWord,
} from '~/server/services/audio-scan/lyric-alignment';
import type { AudioScanParse } from '~/server/services/video-audio-scan.service';

const TRANSCRIBE_STEP = 'transcribe';

/** The stored lyrics as the one text the moderation step reads. */
function lyricsText(lyrics: LyricLine[] | undefined) {
  const text = lyrics?.map((line) => line.text).join('\n');
  return text || undefined;
}

/**
 * The steps that scan one song: a word-timed transcription (skipped when the lyrics already carry
 * their own times) feeding the text moderation, which also reads the lyrics we stored. Step output is
 * handed on by `$ref`, as the video frame scan hands its frames to the rating steps.
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
  const transcribe = !lyricsAreSynced(lyrics);
  const steps = [
    ...(transcribe
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
      $type: 'audioTextModeration',
      name: 'audio',
      metadata,
      priority,
      input: {
        lyrics: lyricsText(lyrics),
        transcription: transcribe ? { $ref: TRANSCRIBE_STEP, path: 'output' } : undefined,
      },
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
  steps: readonly { $type?: string; output?: unknown }[]
): TranscribedWord[] {
  const output = steps.find((step) => step.$type === 'transcription')?.output;
  const parsed = transcriptionOutput.safeParse(output);
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
