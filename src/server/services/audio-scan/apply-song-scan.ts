import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { songVerdict } from '~/server/services/audio-scan/song-scan';
import {
  readLyricsVerdict,
  submitTrackLyricsScan,
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
 * A clean song still waiting on its lyrics verdict. A scan that ended without one counts as a
 * retry, as does a send that throws: the song goes to Error, whose capped lane re-sends only the
 * lyrics (`submitSongScan`), so it stays hidden once the cap is spent. A scan never sent is sent.
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
    await submitTrackLyricsScan({ imageId, content: lyrics.text });
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
  /** Decided because a lyrics verdict landed, not the audio callback. */
  fromLyrics?: boolean;
};

const UNDECIDED: string[] = [ImageIngestionStatus.Pending, ImageIngestionStatus.Error];

/**
 * A song goes public only once its audio and, when it has lyrics, its lyrics have a verdict;
 * whichever lands last decides. A clean song waiting on its lyrics stays Pending and in the ingest
 * queue, so the cron re-drives it and a lyrics scan that never went out is sent again. Flagged audio
 * or blocked lyrics Block it; otherwise it is Scanned at PG until the lyric rating lands. Both go
 * through the image writer, so an appeal, a CSAM flag, a banned or held owner, a moderation rule and
 * a locked level overrule the scan as they do an image.
 */
async function decideSong({ imageId, workflowId, steps, audio, fromLyrics }: SongDecision) {
  const image = await loadImageForScan(imageId);
  const lyrics = await readLyricsVerdict(imageId);
  if (fromLyrics && !UNDECIDED.includes(image.ingestion) && lyrics.state !== 'blocked') return;
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
        : lyrics.state === 'blocked'
        ? { nsfwLevel: NsfwLevel.Blocked, blockedFor: BlockedReason.TOS }
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

/** The audio scan callback for a song. A scan that produced no verdict puts it in Error, which the ingest cron retries. */
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
