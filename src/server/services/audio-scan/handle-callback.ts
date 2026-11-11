import { applySongScanResult } from '~/server/services/audio-scan/apply-song-scan';
import { processAudioScanCallback } from '~/server/services/video-audio-scan.service';

/**
 * Handles the audio scan webhook: stores the scan, and for a song decides its ingestion from it.
 * A video's verdict stays on its scan row. If deciding a song throws, the callback is not
 * retried to success (its scan is already stored); the song stays Pending and the ingest cron
 * resubmits it after its cooldown.
 */
export async function handleAudioScanCallback(workflowId: unknown) {
  const { song, ...result } = await processAudioScanCallback(workflowId);
  if (song) await applySongScanResult(song);
  return result;
}
