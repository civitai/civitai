import pLimit from 'p-limit';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { SelectedImage } from '~/components/Training/Form/ImageSelectModal';
import { IMAGE_MIME_TYPE, MIME_TYPES, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { isDefined } from '~/utils/type-guards';

const importLimit = pLimit(5);

/**
 * Downloads generator images from orchestrator edge URLs and converts them
 * into File objects with preserved metadata.
 *
 * Used by both PostImageDropzone (post creation) and ChallengeSubmitModal (challenge entries).
 */
export async function downloadGeneratorImages(
  assets: SelectedImage[]
): Promise<{ file: File; meta?: Record<string, unknown> }[]> {
  const files = await Promise.all(
    assets.map((asset, idx) =>
      importLimit(async () => {
        try {
          const result = await fetch(getEdgeUrl(asset.url));
          if (!result.ok) return;

          const blob = await result.blob();
          return {
            file: new File(
              [blob],
              `generator_import_${Date.now()}_${idx}.${asset.type === 'video' ? 'mp4' : 'jpg'}`,
              {
                type: [...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE].includes(blob.type as never)
                  ? blob.type
                  : asset.type === 'video'
                  ? MIME_TYPES.mp4
                  : MIME_TYPES.jpeg,
              }
            ),
            meta: asset.meta ?? { prompt: asset.label },
          };
        } catch (e) {
          return;
        }
      })
    )
  );

  return files.filter(isDefined);
}
