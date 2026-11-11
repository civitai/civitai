import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { songVerdict } from '~/server/services/audio-scan/song-scan';
import {
  readLyricsVerdict,
  sendTrackLyricsScan,
  type LyricsVerdict,
} from '~/server/services/audio-scan/track-lyrics';
import { dbWrite } from '~/server/db/client';
import {
  applyIngestionSideEffects,
  extractFailedSteps,
  loadImageForScan,
  markImageScanError,
  resolveScanOutcome,
  sendIngestionSignal,
  type ScanLog,
} from '~/server/services/image-scan-pipeline';
import { removeImageScanJobQueue } from '~/server/services/job-queue.service';
import type { SongScanResult } from '~/server/services/video-audio-scan.service';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const SONG_SCAN_LOG: ScanLog = { name: 'song-scan', source: 'apply-song-scan' };

async function failSong({
  imageId,
  workflowId,
  steps,
  failureType,
  reason,
}: {
  imageId: number;
  workflowId: string;
  steps: unknown[];
  failureType: string;
  reason: string;
}) {
  const { retryCount, userId, failureClass } = await markImageScanError({
    workflowId,
    imageId,
    status: 'failed',
    failureType,
    failedSteps: extractFailedSteps(steps),
    reason,
  });
  logToAxiom(
    {
      name: SONG_SCAN_LOG.name,
      type: 'warning',
      message: 'song scan produced no verdict',
      source: SONG_SCAN_LOG.source,
      imageId,
      workflowId,
      failureType,
      failureClass,
      retryCount,
      reason,
    },
    'webhooks'
  ).catch(() => null);
  await sendIngestionSignal({
    imageId,
    userId,
    ingestion: ImageIngestionStatus.Error,
    log: SONG_SCAN_LOG,
  });
}

/**
 * Waits on the lyrics verdict. A scan that ended without one, or a send that throws, goes through
 * failSong, so the retry cap bounds it.
 */
async function awaitLyrics({
  imageId,
  workflowId,
  lyrics,
}: {
  imageId: number;
  workflowId: string;
  lyrics: Extract<LyricsVerdict, { state: 'pending' }>;
}) {
  if (lyrics.inFlight) return;
  if (lyrics.failed) {
    await failSong({
      imageId,
      workflowId,
      steps: [],
      failureType: 'lyrics-scan-failed',
      reason: 'lyrics scan ended without a verdict',
    });
    return;
  }
  try {
    await sendTrackLyricsScan(imageId);
  } catch (error) {
    await failSong({
      imageId,
      workflowId,
      steps: [],
      failureType: 'lyrics-submit-failed',
      reason: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

type SongDecision = {
  imageId: number;
  workflowId: string;
  steps: unknown[];
  audio: SongScanResult['parsed'];
  fromLyrics?: boolean;
};

const UNDECIDED: string[] = [ImageIngestionStatus.Pending, ImageIngestionStatus.Error];

/**
 * A song goes public only once its audio and, when it has lyrics, its lyrics have a verdict;
 * whichever lands last decides. A clean song waiting on its lyrics stays Pending so the ingest cron
 * re-drives it.
 */
async function decideSong({ imageId, workflowId, steps, audio, fromLyrics }: SongDecision) {
  const image = await loadImageForScan(imageId);
  const lyrics = await readLyricsVerdict(imageId);
  if (fromLyrics && !UNDECIDED.includes(image.ingestion)) return;
  const verdict = songVerdict(audio, lyrics.state !== 'none');

  if (verdict.action === 'retry') {
    if (fromLyrics) return;
    await failSong({
      imageId,
      workflowId,
      steps,
      failureType: (!audio.ok && audio.failureType) || 'unusable-result',
      reason: verdict.reason,
    });
    return;
  }
  if (verdict.action === 'clean' && lyrics.state === 'pending') {
    await awaitLyrics({ imageId, workflowId, lyrics });
    return;
  }

  const outcome = await resolveScanOutcome({
    image,
    workflowId,
    fixed:
      verdict.action === 'block'
        ? { nsfwLevel: NsfwLevel.Blocked, blockedFor: BlockedReason.TOS, minor: true }
        : { nsfwLevel: NsfwLevel.PG },
    log: SONG_SCAN_LOG,
  });

  // The verdict is stored; throwing now would make the caller re-run a finished callback.
  try {
    await removeImageScanJobQueue([imageId]);
    await sendIngestionSignal({
      imageId,
      userId: image.userId,
      ingestion: outcome.ingestion,
      blockedFor: outcome.blockedFor,
      nsfwLevel: outcome.nsfwLevel,
      log: SONG_SCAN_LOG,
    });
    await applyIngestionSideEffects({ image, outcome });
  } catch (error) {
    logToAxiom(
      {
        name: SONG_SCAN_LOG.name,
        type: 'error',
        message: 'side effects failed after the song verdict was stored',
        source: SONG_SCAN_LOG.source,
        imageId,
        workflowId,
        reason: error instanceof Error ? error.message : 'Unknown error',
      },
      'webhooks'
    ).catch(() => null);
  }
}

export async function applySongScanResult({ imageId, workflowId, steps, parsed }: SongScanResult) {
  try {
    await decideSong({ imageId, workflowId, steps, audio: parsed });
  } catch (error) {
    // Deleted between submit and callback: no row to mark.
    if (error instanceof Error && error.message.startsWith('image not found')) return;
    await failSong({
      imageId,
      workflowId,
      steps,
      failureType: 'processing-failed',
      reason: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * A song's lyrics verdict landed. Decides the song when its audio verdict is already stored;
 * otherwise the audio callback will. Throws, so the moderation callback is retried.
 */
export async function applySongLyricsVerdict(imageId: number) {
  const scan = await dbWrite.imageAudioScan.findUnique({
    where: { imageId },
    select: { status: true, workflowId: true, flagged: true, hasAudio: true, result: true },
  });
  if (scan?.status !== 'Succeeded') return;
  await decideSong({
    imageId,
    workflowId: scan.workflowId,
    steps: [],
    audio: {
      ok: true,
      flagged: scan.flagged,
      hasAudio: scan.hasAudio ?? false,
      result: scan.result as never,
    },
    fromLyrics: true,
  });
}
