import {
  invokeLyricsAlignmentStepTemplate,
  type LyricsAlignmentLine,
} from '@civitai/orchestration-client';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { lyricLineSchema, type LyricLine } from '~/server/schema/media.schema';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { isAllowedImageScanUrl, normalizeImageScanUrl } from '~/server/utils/image-scan-url';
import { MediaType, TrackLyricsSource } from '~/shared/utils/prisma/enums';

/**
 * The stored lines with the alignment's start times (seconds → ms). Labels and other ignored lines
 * stay untimed. Undefined when the alignment's sung lines are not the stored lines, or none is timed.
 */
export function toAlignedLines(
  stored: LyricLine[],
  aligned: LyricsAlignmentLine[]
): LyricLine[] | undefined {
  // The stored lines are the text's non-blank lines, trimmed (`parseLyricLines`).
  const sung = aligned.filter((line) => line.text.trim());
  if (sung.length !== stored.length) return undefined;
  if (sung.some((line, i) => line.text.trim() !== stored[i].text)) return undefined;
  const lines = stored.map(({ text }, i) => {
    const { status, startTime } = sung[i];
    const timed = status !== 'ignored' && typeof startTime === 'number' && startTime >= 0;
    return { t: timed ? Math.round(startTime * 1000) : null, text };
  });
  return lines.some((line) => line.t !== null) ? lines : undefined;
}

/**
 * Times a song's stored lyrics against its audio, so the player can follow them. The text is
 * unchanged, so its scan stands. A song the orchestrator can't align (204) stays untimed, as do
 * lyrics replaced while the alignment ran. Resolves whether lines were timed.
 */
export async function alignTrackLyrics({ imageId, url }: { imageId: number; url: string }) {
  if (!isAllowedImageScanUrl(url)) return false;
  // primary: called right after the lyrics are written
  const stored = await dbWrite.trackLyrics.findUnique({
    where: { imageId },
    select: { text: true, lines: true },
  });
  const lines = lyricLineSchema.array().safeParse(stored?.lines).data;
  if (!stored || !lines?.length) return false;

  const { data, error, response } = await invokeLyricsAlignmentStepTemplate({
    client: internalOrchestratorClient,
    body: {
      mediaUrl: getEdgeUrl(normalizeImageScanUrl(url), { type: MediaType.audio }),
      lyrics: stored.text,
    },
  });
  if (response?.status === 204) return false;
  // Logged: a recipe that keeps failing, or starts reshaping the text, would leave every song untimed.
  if (!data?.lines) {
    logAlignment(imageId, 'failed', { status: response?.status, error });
    return false;
  }
  const timed = toAlignedLines(lines, data.lines);
  if (!timed) {
    logAlignment(imageId, 'unmatched', { stored: lines.length, aligned: data.lines.length });
    return false;
  }

  const { count } = await dbWrite.trackLyrics.updateMany({
    where: { imageId, text: stored.text },
    data: { lines: timed, source: TrackLyricsSource.aligned },
  });
  return count > 0;
}

function logAlignment(imageId: number, outcome: string, details: Record<string, unknown>) {
  void logToAxiom({ type: 'warning', name: 'lyrics-alignment', imageId, outcome, ...details });
}
