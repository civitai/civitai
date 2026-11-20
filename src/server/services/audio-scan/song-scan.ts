import type { Priority, WorkflowStepTemplate } from '@civitai/orchestration-client';
import type { AudioScanParse } from '~/server/services/video-audio-scan.service';

/** The step whose verdict decides a song and shadows a video's audio. */
export function buildAudioModerationStep({
  mediaUrl,
  metadata,
  priority,
}: {
  mediaUrl: string;
  metadata: Record<string, unknown>;
  priority?: Priority;
}) {
  // The client's step types predate this step.
  return {
    $type: 'audioModeration',
    name: 'audio',
    metadata,
    priority,
    input: { mediaUrl, transcriber: 'auto' },
  } as unknown as WorkflowStepTemplate;
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
