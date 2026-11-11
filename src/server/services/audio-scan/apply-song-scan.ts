import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { audioMetadataSchema } from '~/server/schema/media.schema';
import { alignLyrics } from '~/server/services/audio-scan/lyric-alignment';
import { readTranscriptionWords, songVerdict } from '~/server/services/audio-scan/song-scan';
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

/**
 * The song's metadata with its lyrics timed against the transcription, or nothing when they cannot
 * be. The lyrics go through `audioMetadataSchema` with the rest of the metadata, so a row that no
 * longer parses keeps what it had.
 */
function syncedMetadata(metadata: unknown, steps: unknown[]) {
  const stored = audioMetadataSchema.safeParse(metadata);
  const words = readTranscriptionWords(steps as { $type?: string; output?: unknown }[]);
  if (!stored.success || !words.length) return;

  const lyrics = alignLyrics({ lyrics: stored.data.lyrics, words });
  if (!lyrics.length) return;
  const synced = audioMetadataSchema.safeParse({ ...stored.data, lyrics });
  if (!synced.success) return;
  return { ...(metadata as Record<string, unknown>), lyrics: synced.data.lyrics };
}

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
 * Decides a song's ingestion from its stored scan result. A flagged song is Blocked; any other is
 * Scanned at PG until the lyric rating lands. Both go through the image writer, so an appeal, a CSAM
 * flag, a banned or held owner, a moderation rule and a locked level overrule the scan as they do an
 * image. A scan that produced no verdict puts the song in Error, which the ingest cron retries.
 */
export async function applySongScanResult({ imageId, workflowId, steps, parsed }: SongScanResult) {
  let image: Awaited<ReturnType<typeof loadImageForScan>>;
  let outcome: Awaited<ReturnType<typeof resolveScanOutcome>>;
  try {
    image = await loadImageForScan(imageId);
    const storedLyrics = audioMetadataSchema.shape.lyrics.safeParse(
      (image.metadata as { lyrics?: unknown } | null)?.lyrics
    );
    const hasStoredLyrics = storedLyrics.success && !!storedLyrics.data?.length;
    const verdict = songVerdict(parsed, hasStoredLyrics);

    if (verdict.action === 'retry') {
      await failSong({
        imageId,
        workflowId,
        steps,
        failureType: (!parsed.ok && parsed.failureType) || 'unusable-result',
        reason: verdict.reason,
      });
      return;
    }

    // Stored with the verdict, and read by the writer's moderation rules, so no later write can undo it.
    const metadata = verdict.action === 'clean' ? syncedMetadata(image.metadata, steps) : undefined;
    if (metadata) image = { ...image, metadata: metadata as typeof image.metadata };
    outcome = await resolveScanOutcome({
      image,
      workflowId,
      fixed:
        verdict.action === 'block'
          ? { nsfwLevel: NsfwLevel.Blocked, blockedFor: BlockedReason.TOS }
          : { nsfwLevel: NsfwLevel.PG, metadata },
      log: SONG_SCAN_LOG,
    });
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
    return;
  }

  // The verdict is stored; throwing now would make the orchestrator re-run a finished callback.
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
