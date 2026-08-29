import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { BulkPanelItem } from '~/components/Comics/comic-project-constants';
import { getMetadata } from '~/utils/metadata';
import type { BatchUploadFailure } from '~/utils/upload-batch';

/**
 * The bulk-panel drop loop, lifted out of `PanelModal` so its control flow can be driven
 * by a test.
 *
 * 🔴 WHY IT LIVES HERE. The policy this loop implements — *keep going when one file is
 * refused, and report which ones were* — is the finding the round-2 audit raised, and it
 * was previously unexercised by anything: `PanelModal` takes ~40 required props and pulls
 * in the Buzz account hooks, feature flags, a tRPC query, dnd-kit and `dialogStore`, so
 * "reviewed by reading" was the honest label for it. As a module function it is driven
 * directly, with a real `File`, a real `URL.createObjectURL` and the real metadata reader.
 *
 * `uploadToCF` is a parameter because it is a React hook's method; everything else is the
 * production import.
 */

/**
 * What a panel falls back to when the browser cannot decode the dropped file.
 *
 * Pre-existing behaviour, kept: an undecodable image still uploads, and the server sizes
 * it later. Named rather than inlined so the test asserting the fallback is not restating
 * a literal from the implementation it tests.
 */
export const BULK_PANEL_FALLBACK_DIMENSIONS = { width: 512, height: 512 } as const;

export type BulkPanelUploadResult = {
  /** The panels that uploaded, in drop order. */
  items: BulkPanelItem[];
  /**
   * One entry per file that did not produce a panel, in drop order — normally a refused
   * upload, but any throw raised while processing that file lands here too rather than
   * escaping and taking the whole batch with it.
   */
  failed: BatchUploadFailure[];
};

/** Decode the file just far enough to read its natural size. */
async function readDimensions(file: File): Promise<{ width: number; height: number }> {
  const img = new window.Image();
  const objectUrl = URL.createObjectURL(file);
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(objectUrl);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image'));
    };
    img.src = objectUrl;
  }).catch(() => ({ ...BULK_PANEL_FALLBACK_DIMENSIONS }));
}

/**
 * Extract embedded generation metadata (Automatic1111 / ComfyUI / SwarmUI / RuinedFooocus
 * PNG tags) so the panel's `Image` can be attributed to whatever model produced it.
 * Failures are non-fatal — the panel is still worth creating without attribution.
 */
async function readMeta(file: File): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await getMetadata(file);
    if (parsed && Object.keys(parsed).length > 0) return parsed;
  } catch (err) {
    console.error('Failed to extract metadata from uploaded image:', err);
  }
  return undefined;
}

export async function uploadBulkPanels({
  files,
  uploadToCF,
}: {
  files: File[];
  uploadToCF: (file: File) => Promise<{ id: string }>;
}): Promise<BulkPanelUploadResult> {
  const items: BulkPanelItem[] = [];
  const failed: BatchUploadFailure[] = [];

  for (const file of files) {
    /**
     * 🔴 PER FILE, AND AROUND THE WHOLE BODY — the same remedy `character.tsx`'s reference
     * loop got, plus the width that makes `items` survivable.
     *
     * Two separate reasons this `try` is shaped the way it is:
     *
     * 1. PER FILE, so one refused PUT does not end the batch. This loop originally had no
     *    catch at all, then a whole-loop one. Both stop on the first refusal: files 3–10 are
     *    never attempted, and the user is told "Failed to upload image" with no file named
     *    and no count. Stopping was never a decision — it was the shape a `try` around the
     *    whole loop happens to have. Two identically-shaped loops must not have two
     *    different answers to one question, so both continue, and the caller reports the
     *    failures it is handed.
     *
     * 2. AROUND THE WHOLE BODY, so nothing thrown while processing file N can discard the
     *    panels files 1..N−1 already uploaded. `uploadBulkPanels` returns `items` by value
     *    and its caller assigns them only after it returns as a whole, so a throw that
     *    escapes this loop is silent data loss for uploads the user watched succeed. The
     *    narrower "upload only" version of this `try` used to carry a comment claiming the
     *    reads above "cannot reach here"; that was false — `URL.createObjectURL` in
     *    `readDimensions` sits outside every `try` in that helper, and a synchronous throw
     *    from it rejects the awaited promise. Unlikely, but the point of the wide `try` is
     *    that a future line added anywhere in this body is covered by construction rather
     *    than by re-deriving that argument.
     *
     * Pinned by `bulk-panel-upload.browser.test.tsx` — both the refused-PUT case and the
     * mid-loop-throw case, the latter by making `URL.createObjectURL` throw on one file.
     */
    try {
      const dims = await readDimensions(file);
      const meta = await readMeta(file);
      const result = await uploadToCF(file);

      items.push({
        id: `bulk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sourceImage: {
          url: result.id,
          cfId: result.id,
          width: dims.width,
          height: dims.height,
          preview: getEdgeUrl(result.id, { width: 120 }) ?? result.id,
        },
        prompt: '',
        aspectRatio: '3:4',
        meta,
      });
    } catch (error) {
      failed.push({ name: file.name, error: error as Error });
    }
  }

  return { items, failed };
}
