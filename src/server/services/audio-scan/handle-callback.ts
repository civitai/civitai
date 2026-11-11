import { applySongScanResult } from '~/server/services/audio-scan/apply-song-scan';
import { processAudioScanCallback } from '~/server/services/video-audio-scan.service';

/** Stores the scan and, for a song, decides its ingestion. A video's verdict stays on its scan row. */
export async function handleAudioScanCallback(workflowId: unknown) {
  const { song, ...result } = await processAudioScanCallback(workflowId);
  if (song) await applySongScanResult(song);
  return result;
}
