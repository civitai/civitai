import { dialogStore } from '~/components/Dialog/dialogStore';
import { downloadGeneratorImages } from '~/utils/generator-import';
import { showErrorNotification } from '~/utils/notifications';

/**
 * Download a generator image using the standard flow and upload it via the provided upload function.
 * Uses `downloadGeneratorImages` (same as posts/challenges) for the download step.
 */
export async function fetchAndUploadGeneratorImage(
  imageUrl: string,
  fileNameBase: string,
  uploadFn: (file: File) => Promise<{ id: string }>
): Promise<string> {
  const files = await downloadGeneratorImages([
    { url: imageUrl, label: fileNameBase, type: 'image' as const },
  ]);
  if (files.length === 0) throw new Error('Failed to download image from generator');
  const result = await uploadFn(files[0].file);
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
 * Open the generator image picker, download the selected image via standard flow,
 * upload to S3, and call onSuccess with the S3 key.
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
          const s3Key = await fetchAndUploadGeneratorImage(selected[0].url, fileNameBase, uploadFn);
          onSuccess(s3Key);
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
