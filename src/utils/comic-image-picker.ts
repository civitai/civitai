import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { showErrorNotification } from '~/utils/notifications';

/**
 * Fetch a generator image by URL, upload the blob to CF, and return the CF image ID.
 * This is the low-level primitive used by all generator-image-pick flows.
 */
export async function fetchAndUploadGeneratorImage(
  imageUrl: string,
  fileNameBase: string,
  uploadFn: (file: File) => Promise<{ id: string }>
): Promise<string> {
  const edgeUrl = getEdgeUrl(imageUrl, { original: true }) ?? imageUrl;
  const response = await fetch(edgeUrl);
  if (!response.ok) throw new Error('Failed to fetch image');
  const blob = await response.blob();
  const ext = blob.type.split('/')[1] || 'jpg';
  const file = new File([blob], `${fileNameBase}_${Date.now()}.${ext}`, { type: blob.type });
  const result = await uploadFn(file);
  return result.id;
}

type GeneratorPickOptions = {
  title: string;
  fileNameBase: string;
  uploadFn: (file: File) => Promise<{ id: string }>;
  onSuccess: (id: string) => void;
  onLoadingChange?: (loading: boolean) => void;
  ImageSelectModal: React.ComponentType<any>;
};

/**
 * Open the generator image picker, fetch the selected image, upload to CF, and call onSuccess.
 * Convenience wrapper for single-select flows (cover/hero images).
 */
export function openGeneratorImagePicker({
  title,
  fileNameBase,
  uploadFn,
  onSuccess,
  onLoadingChange,
  ImageSelectModal,
}: GeneratorPickOptions) {
  dialogStore.trigger({
    component: ImageSelectModal,
    props: {
      title,
      selectSource: 'generation' as const,
      videoAllowed: false,
      importedUrls: [],
      onSelect: async (selected: { url: string; meta?: Record<string, unknown> }[]) => {
        if (selected.length === 0) return;
        try {
          onLoadingChange?.(true);
          const cfId = await fetchAndUploadGeneratorImage(selected[0].url, fileNameBase, uploadFn);
          onSuccess(cfId);
        } catch (err) {
          console.error(`Failed to upload generator image for ${fileNameBase}:`, err);
          showErrorNotification({
            error: new Error(`Could not upload ${fileNameBase} image. Please try again.`),
            title: 'Upload Failed',
          });
        } finally {
          onLoadingChange?.(false);
        }
      },
    },
  });
}
