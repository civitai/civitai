import { getEdgeUrl } from '~/client-utils/edge-url';
import { logToAxiom } from '~/server/logging/client';
import { getVideoMetadata } from '~/server/services/orchestrator/videoEnhancement';
import { isAllowedImageScanUrl, normalizeImageScanUrl } from '~/server/utils/image-scan-url';
import { MediaType } from '~/shared/utils/prisma/enums';

// ffprobe runs on the orchestrator while it builds the workflow, so this sits on the caller's
// request; past this the video is created without dimensions rather than held up.
const PROBE_DEADLINE_MS = 10_000;

export type VideoDimensions = { width: number; height: number; duration?: number };

/** A .NET TimeSpan string (`[d.]hh:mm:ss[.fffffff]`) in seconds. */
export function parseTimeSpanSeconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return undefined;
  const [, days = '0', hours, minutes, seconds] = match;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Width, height and duration of a stored video, or null when they can't be read. */
export async function probeVideoDimensions(url: string): Promise<VideoDimensions | null> {
  if (!isAllowedImageScanUrl(url)) return null;
  const videoUrl = getEdgeUrl(normalizeImageScanUrl(url), { type: MediaType.video });

  try {
    const metadata = await Promise.race([
      getVideoMetadata({ videoUrl }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('video metadata probe timed out')), PROBE_DEADLINE_MS)
      ),
    ]);
    const { width, height } = metadata;
    if (!(width > 0) || !(height > 0)) return null;
    const duration = parseTimeSpanSeconds(metadata.duration);
    return { width, height, duration: duration && duration > 0 ? duration : undefined };
  } catch (e) {
    void logToAxiom({
      type: 'warning',
      name: 'video-dimensions-probe',
      message: (e as Error).message,
      url,
    }).catch(() => null);
    return null;
  }
}
