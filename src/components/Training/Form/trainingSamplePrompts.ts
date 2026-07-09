import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import type { AudioSampleOverride } from '~/utils/training';
import { parseAudioCaption } from '~/utils/training';
import { getJSZip } from '~/utils/lazy';

/**
 * Download the existing Training Data zip for a version and return just the caption
 * strings (the per-image `.txt` label files). Unlike the full Step-2 parse, this skips
 * image decoding — we only need the text to seed sample prompts.
 *
 * Used on Step 3 when the user lands there directly (refresh / deep-link) without going
 * through Step 2, so the in-memory image list (and its captions) was never hydrated.
 */
export async function fetchTrainingDataCaptions(versionId: number): Promise<string[]> {
  const url = createModelFileDownloadUrl({ versionId, type: 'Training Data' });
  const result = await fetch(url);
  if (!result.ok) return [];
  const blob = await result.blob();

  const zipReader = await getJSZip();
  const zData = await zipReader.loadAsync(blob);

  const captions: string[] = [];
  for (const [zname, zf] of Object.entries(zData.files)) {
    if (zf.dir) continue;
    if (zname.startsWith('__MACOSX/') || zname.endsWith('.DS_STORE')) continue;
    if (!zname.toLowerCase().endsWith('.txt')) continue;
    const txt = await zf.async('string');
    if (txt && txt.trim()) captions.push(txt.trim());
  }
  return captions;
}

/**
 * Pick up to N random captions and shape them into sample prompts (and, for audio,
 * per-sample overrides parsed from the XML-tagged caption). Mirrors the prefill in
 * AdvancedSettings so both the Step-2→3 flow and a direct Step-3 landing behave the same.
 * Video uses 2 slots; image and audio use 3.
 */
export function buildSamplePromptsFromCaptions(
  captions: string[],
  mediaType: TrainingDetailsObj['mediaType']
): { prompts: string[]; overrides: AudioSampleOverride[] } {
  const numPromptsNeeded = mediaType === 'video' ? 2 : 3;
  const withContent = captions.filter((c) => c && c.trim().length > 0);

  const picked: string[] = [];
  const usedIndices = new Set<number>();
  while (picked.length < numPromptsNeeded && picked.length < withContent.length) {
    const randomIndex = Math.floor(Math.random() * withContent.length);
    if (!usedIndices.has(randomIndex)) {
      usedIndices.add(randomIndex);
      picked.push(withContent[randomIndex]);
    }
  }

  const prompts: string[] = [];
  const overrides: AudioSampleOverride[] = [];
  for (let i = 0; i < numPromptsNeeded; i++) {
    const raw = picked[i] ?? '';
    if (mediaType === 'audio' && raw) {
      const parsed = parseAudioCaption(raw);
      prompts.push(parsed.caption ?? raw);
      overrides.push({
        ...(parsed.lyrics && { lyrics: parsed.lyrics }),
        ...(parsed.duration && { duration: parsed.duration }),
        ...(parsed.language && { language: parsed.language }),
      });
    } else {
      prompts.push(raw);
      overrides.push({});
    }
  }
  return { prompts, overrides };
}
